# AML Transaction Monitoring Tool - Requirements Document

**Document Version:** 1.0  
**Date:** April 15, 2026  
**Prepared for:** City SACCO System  
**Subject:** Implementation of AML Transaction Monitoring Tool  
**Regulatory Framework:** Anti-Money Laundering Act, 2013 (as amended)

---

## Executive Summary

This document outlines the functional and non-functional requirements for implementing an **AML Transaction Monitoring Tool** within the City SACCO System. The tool will enable real-time identification and monitoring of suspicious transactions, unusual account behaviors, and large cash transactions to ensure compliance with the Anti-Money Laundering Act, 2013 (as amended) and facilitate timely reporting to the Financial Intelligence Authority (FIA).

The implementation of this tool is critical to:
- Strengthen the organization's compliance framework
- Mitigate reputational and operational risks
- Automate detection of potential money laundering red flags
- Enable timely Large Cash Transaction (LCT) reporting to the FIA

---

## 1. Regulatory Background

### 1.1 Compliance Requirements

**Governing Legislation:**
- Anti-Money Laundering Act, 2013 (as amended)
- Any subsequent amendments and regulatory guidance from the Financial Intelligence Authority (FIA)

**Key Obligations:**
- Monitor member transactions for suspicious patterns
- Identify and flag unusual account behaviors
- Report large cash transactions to the FIA
- Maintain audit trails of all monitoring activities
- Ensure timely submission of reports (Large Cash Transaction reports by every Tuesday of the following week)

### 1.2 Reporting Obligations

- **Large Cash Transaction (LCT) Reports:** Submitted to FIA every Tuesday of the following week for all transactions exceeding UGX 20,000,000 in a single day
- **Suspicious Activity Reports (SARs):** Submitted when suspicious transaction patterns are identified
- **Record Keeping:** Maintain comprehensive records of all monitoring activities and transactions flagged

---

## 2. Functional Requirements

### 2.1 Real-Time Transaction Monitoring

**FR-1: Transaction Capture**
- System shall automatically capture and record all member transactions in real-time
- Transactions shall include: transaction date/time, member ID, transaction type (deposit/withdrawal), amount, counterparty details, and transaction description
- System shall log all transactions with complete audit trail

**FR-2: Large Cash Transaction Detection (LCT)**
- System shall automatically identify transactions where the amount equals or exceeds **UGX 20,000,000** in a single day by any member
- System shall flag cumulative daily transactions per member that exceed UGX 20,000,000 (sum of multiple transactions in one day)
- LCT flagged transactions shall be marked with a "LCT_FLAG" status
- System shall provide alert notifications for LCT transactions within 5 minutes of transaction completion

**FR-3: Suspicious Activity Identification**
- System shall detect suspicious transaction patterns including:
  - **Structuring Patterns:** Multiple small transactions totaling large amounts within short timeframes (24-48 hours)
  - **Unusual Frequency:** Abnormally high number of transactions by a member compared to their historical average
  - **Round Amounts:** Multiple transactions of suspiciously round numbers (e.g., exactly UGX 10,000,000 repeatedly)
  - **Off-Peak Timing:** Large transactions occurring outside normal business hours
  - **Rapid Movement:** Money deposited and withdrawn within short timeframes (< 1 hour)
  - **High-Risk Counterparties:** Transactions with known high-risk entities or geographic locations
  - **Velocity Changes:** Sudden spikes in transaction frequency or amounts for dormant accounts

**FR-4: Unusual Account Behavior Detection**
- System shall monitor and flag:
  - Sudden activation of dormant accounts
  - Significant increase in transaction volume compared to baseline (>150% in rolling 30-day period)
  - Significant increase in transaction amounts compared to baseline (>200% in rolling 30-day period)
  - Multiple account linkages by same member or related parties
  - Accounts with international transaction patterns (if applicable)

**FR-5: Risk Scoring**
- System shall calculate risk scores for each flagged transaction/behavior based on:
  - Transaction amount (weight: 25%)
  - Frequency anomaly (weight: 20%)
  - Pattern matching to known risk indicators (weight: 25%)
  - Member profile risk factors (weight: 30%)
- Risk scores shall range from 1-100 (where 1 = low risk, 100 = high risk)
- Transactions with risk score ≥ 70 shall be automatically escalated for review

### 2.2 Member Profile Management

**FR-6: Member Risk Classification**
- System shall maintain and update member risk profiles based on:
  - KYC information completeness
  - Historical transaction patterns
  - Geographic risk factors
  - Occupation/business type
  - Previous suspicious activity flags
- Risk classification: Low, Medium, High, Very High
- System shall auto-update profiles monthly based on new transaction data

**FR-7: Baseline Behavior Establishment**
- System shall establish transaction baselines per member based on 90-day historical data
- Baselines shall include: average daily transaction amount, typical transaction frequency, peak transaction hours, typical counterparty patterns
- System shall auto-recalibrate baselines monthly

### 2.3 Alerting & Notifications

**FR-8: Alert Generation**
- System shall generate alerts for:
  - Large Cash Transactions (LCT) - immediately upon threshold breach
  - High-risk suspicious activity (score ≥ 70) - immediately
  - Medium-risk suspicious activity (score 50-69) - within 1 hour
  - Low-risk flags (score <50) - daily batch summary
- Alerts shall include transaction details, risk score, pattern matched, and recommended action

**FR-9: Alert Escalation**
- Compliance officers shall receive real-time notifications for LCT and High-risk alerts
- Alerts shall be routable to compliance team for investigation
- Alerts shall include "snooze" (defer review for X hours) and "dismiss" (mark as reviewed) options

### 2.4 Investigation & Case Management

**FR-10: Flagged Transaction Review**
- System shall provide detailed view of flagged transactions including:
  - Transaction details (amount, date, parties, description)
  - Risk score and scoring breakdown
  - Historical transactions from same member
  - Pattern analysis and matched indicators
  - Member profile summary
- Compliance officers shall be able to add investigation notes and attach supporting documents

**FR-11: Case Management**
- System shall allow investigators to:
  - Create cases from flagged transactions
  - Link related transactions to same case
  - Track case status (New, Under Review, Pending Report, Reported, Closed)
  - Add investigation outcomes and decisions
  - Record final risk determination (False Positive, Legitimate Activity, Suspicious Activity - Report Required)

**FR-12: Decision Audit Trail**
- System shall maintain complete audit trail of all investigation decisions including:
  - Date/time of decision
  - Decision maker (user ID)
  - Action taken (flag dismissed, approved for reporting, etc.)
  - Supporting notes and evidence

### 2.5 Reporting & Compliance

**FR-13: Large Cash Transaction Report Generation**
- System shall automatically compile LCT reports for submission to FIA
- Reports shall include:
  - All transactions ≥ UGX 20,000,000 from the previous week
  - Member identification details
  - Transaction amounts, dates, and descriptions
  - Counterparty information
  - Submission date and authorization
- Reports shall be generated every Monday morning for Tuesday FIA submission
- Reports shall be exportable to FIA-approved format (PDF/Excel/XML as specified)

**FR-14: Suspicious Activity Report (SAR) Generation**
- System shall generate formal SAR for submission to FIA when investigation concludes with "Suspicious Activity - Report Required"
- SARs shall include:
  - Member identification and account details
  - Detailed description of suspicious activity and patterns identified
  - Transaction details (amounts, dates, counterparties)
  - Risk assessment and scoring rationale
  - Investigation timeline and findings
  - Recommended actions/indicators of concern

**FR-15: Report Management**
- System shall maintain:
  - Submission history with confirmation of FIA receipt
  - Draft reports pending authorization
  - Archive of all submitted reports
  - Export capabilities for regulatory audits
- Authorized compliance officers shall sign-off on reports before submission

### 2.6 Administrative & Configuration

**FR-16: Threshold Configuration**
- Admin users shall be able to configure:
  - LCT threshold amount (default: UGX 20,000,000)
  - Risk score thresholds for escalation
  - Structuring detection timeframe (24/48 hours, configurable)
  - Baseline recalibration frequency
  - Alert notification preferences per user

**FR-17: Rules Engine Management**
- System shall allow compliance officers to:
  - Create custom suspicious activity rules (if ruleset is customizable)
  - Enable/disable specific detection rules
  - Adjust rule sensitivity/weightings
  - View rule effectiveness metrics
  - Maintain rule documentation and update history

**FR-18: User Access Control**
- System shall support role-based access control:
  - **Admin:** System configuration, user management, report approval
  - **Compliance Officer:** Alert review, investigation, report generation
  - **Audit:** Read-only access to audit logs, reports, and investigations
  - **System Admin:** Technical system maintenance
- User actions shall be logged with full audit trail

**FR-19: System Logging & Audit Trail**
- System shall maintain comprehensive logs including:
  - All transactions processed
  - All alerts generated
  - All alerts reviewed/dismissed
  - All investigation activities
  - All report submissions
  - All configuration changes
  - All user logins and actions
- Logs shall be retained for minimum 7 years per regulatory requirements

---

## 3. Non-Functional Requirements

### 3.1 Performance

**NFR-1: Transaction Processing Latency**
- System shall process and analyze each transaction within **2 seconds** of receipt
- LCT alerts shall be generated within **5 minutes** of transaction completion
- Suspicious activity alerts shall be generated within **1 hour** of transaction processing
- Database query response time for member reports shall be < 3 seconds for standard queries

**NFR-2: System Availability**
- System shall maintain **99.5% uptime** during business hours (8 AM - 6 PM weekdays)
- System shall support weekend/holiday emergency access for critical alerts
- Planned maintenance windows shall be scheduled outside peak business hours

**NFR-3: Scalability**
- System shall support monitoring of:
  - Minimum 10,000 active members
  - Minimum 100,000 transactions per day (with capacity for 500,000/day)
  - Historical data retention: 7+ years
- System shall scale horizontally to accommodate future member growth

### 3.2 Security & Data Protection

**NFR-4: Data Encryption**
- All sensitive data (member PII, transaction details) shall be encrypted at rest using AES-256 or equivalent
- All data in transit shall be encrypted using TLS 1.3 or higher
- Encryption keys shall be managed securely with regular rotation (quarterly minimum)

**NFR-5: Access Control**
- Multi-factor authentication (MFA) required for all compliance officer logins
- Session timeout: 30 minutes of inactivity
- Password policy: Minimum 12 characters, complexity requirements, 90-day rotation
- All access attempts (successful and failed) shall be logged

**NFR-6: Data Privacy**
- System shall comply with any applicable data protection legislation
- Member PII shall be masked in non-essential displays (e.g., show last 4 digits of ID number only)
- Sensitive investigation notes shall have restricted access controls
- Audit logs shall be accessible only to authorized personnel

**NFR-7: Backup & Disaster Recovery**
- Automated daily backups of all system data
- Backup retention: Minimum 90 days (incremental), 7 years (annual snapshots)
- Recovery Time Objective (RTO): 4 hours
- Recovery Point Objective (RPO): 1 hour
- Backup integrity verification and tested restoration monthly

### 3.3 Integration & Interoperability

**NFR-8: System Integration**
- System shall integrate with existing City SACCO System components:
  - Member database (for KYC and profile information)
  - Transaction processing system (for real-time transaction feeds)
  - Reporting framework (for FIA report export)
- API integration via REST/JSON or mutually agreed protocol

**NFR-9: Data Exchange Formats**
- Transaction data imports: JSON, CSV (with validation)
- Report exports: PDF, Excel (XLSX), XML (FIA-compliant format)
- Audit log exports: CSV, JSON

### 3.4 Compliance & Documentation

**NFR-10: Regulatory Compliance**
- System shall maintain audit-ready documentation and evidence of:
  - Compliance with AML Act, 2013 requirements
  - Adherence to FIA reporting obligations
  - Regular system testing and validation
  - Staff training and competency records

**NFR-11: System Documentation**
- Complete technical documentation including:
  - System architecture and design
  - Database schema and data dictionary
  - Configuration guide and customization procedures
  - Administration manual and user guides
  - API documentation for integrations
  - Disaster recovery and operations procedures

**NFR-12: Change Management**
- All system changes shall be:
  - Documented with business justification
  - Tested in non-production environment
  - Reviewed and approved by compliance officer and IT manager
  - Rolled back if compliance issues identified
- Audit trail of all changes maintained

### 3.5 Usability & Support

**NFR-13: User Interface**
- Intuitive dashboard with key metrics and alerts at a glance
- Consistent design language with existing City SACCO System
- Mobile-responsive interface for alert notifications
- Keyboard navigation and accessibility compliance (WCAG 2.1 AA minimum)

**NFR-14: Reporting & Analytics**
- Pre-built reports: LCT summary, SAR status, alert trends, rule effectiveness
- Ad-hoc query builder for custom analysis
- Data export capabilities for external analysis
- Dashboard visualizations: alert trends, top flagged members, pattern breakdown

**NFR-15: Training & Support**
- System shall include:
  - Comprehensive user manuals (admin, compliance officer, auditor roles)
  - Video training materials for key workflows
  - Context-sensitive help within application
  - Support documentation and FAQ
- Initial staff training during implementation (minimum 2 days)
- Quarterly refresher training recommended

---

## 4. System Components & Architecture

### 4.1 Core Components

1. **Transaction Monitoring Engine**
   - Real-time transaction processing
   - Pattern matching and anomaly detection
   - Risk scoring and alert generation

2. **Member Profile Manager**
   - KYC information repository
   - Risk profile maintenance
   - Baseline behavior tracking
   - Historical transaction analysis

3. **Alert Management System**
   - Alert generation and routing
   - Alert acknowledgment and investigation tracking
   - Escalation workflows
   - Alert notification delivery (email, SMS, dashboard)

4. **Compliance & Reporting Module**
   - LCT and SAR report generation
   - Report submission tracking
   - Compliance documentation
   - Regulatory requirement tracking

5. **Investigation & Case Management**
   - Flagged transaction detailed review
   - Case creation and tracking
   - Investigation notes and evidence attachment
   - Decision recording and audit trail

6. **Administrative Dashboard**
   - System configuration and monitoring
   - User and role management
   - Audit log review
   - System health and performance monitoring

7. **Analytics & Reporting**
   - Trend analysis and reporting
   - Rule effectiveness metrics
   - Compliance reporting
   - Custom query builder

### 4.2 Data Storage

- **Transaction Database:** Real-time transactional data (current + 7 years historical)
- **Member Profiles:** KYC and risk profile data
- **Alerts & Cases:** Alert history, investigation cases, outcomes
- **Audit Logs:** Complete system audit trail
- **Reports:** Generated and submitted reports with FIA confirmation

---

## 5. Data Requirements

### 5.1 Transaction Data Elements

Required fields for each transaction:
- Transaction ID (unique identifier)
- Member ID (originator)
- Transaction Type (Deposit/Withdrawal/Transfer)
- Transaction Amount (currency: UGX)
- Transaction Date/Time (with timezone)
- Counterparty Name (if applicable)
- Counterparty Account/ID (if applicable)
- Description/Narration
- Processing Status
- Channel (ATM/Mobile/Branch/Online)
- Location (branch/ATM location if applicable)

### 5.2 Member Data Elements

Required fields:
- Member ID (unique)
- Full Name
- Date of Birth
- National ID/Passport Number
- Residential Address
- Contact Phone/Email
- Employment/Business Information
- Occupation/Business Type
- Account Opening Date
- KYC Completion Date
- Risk Classification
- Account Status (Active/Inactive/Suspended)
- Linked Account IDs (if applicable)

### 5.3 Alert & Investigation Data

- Alert ID
- Transaction ID(s) referenced
- Alert Type (LCT/Suspicious Pattern/Behavioral Anomaly)
- Risk Score
- Pattern(s) Matched
- Creation Timestamp
- Status (New/Under Review/Reviewed/Escalated)
- Investigation Case ID (if created)
- Investigator Notes
- Decision and Outcome
- Report Status (if reported)

---

## 6. Reporting Requirements

### 6.1 Large Cash Transaction (LCT) Reports

**Frequency:** Weekly  
**Submission Deadline:** Every Tuesday for transactions from the previous week (Monday-Sunday)  
**Recipient:** Financial Intelligence Authority (FIA)

**Required Information per Transaction:**
- Transaction date
- Member identification (name, ID number, account number)
- Transaction amount
- Transaction description/purpose
- Counterparty information (if applicable)
- Submitting institution details
- Certification of accuracy and completeness

**Report Format:** As specified by FIA (currently PDF/Excel/XML)

### 6.2 Suspicious Activity Reports (SARs)

**Frequency:** As warranted by investigation outcome  
**Recipient:** Financial Intelligence Authority (FIA)  
**Timeline:** Within 7 days of completing investigation

**Required Information:**
- Complete member identification and account details
- Detailed narrative of suspicious activity
- Timeline of related transactions
- Pattern analysis and indicators of concern
- Risk assessment
- Investigator findings and rationale
- Evidence and supporting documentation
- Institutional certification and authority

### 6.3 Internal Compliance Reports

**Daily Reports:**
- Alert Summary: Count by type and risk level
- Escalated Cases: New high-risk investigations
- Report Status: Pending FIA submissions

**Weekly Reports:**
- LCT Report: All flagged transactions
- Alert Metrics: Generated, reviewed, escalated, dismissed
- Investigation Status: Open cases, completed cases

**Monthly Reports:**
- Compliance Dashboard: Key metrics and trends
- Rule Effectiveness: Top detection rules, false positive rates
- Member Risk Analysis: Top flagged members, trends
- Staff Performance: Alert reviews per officer

**Quarterly Reports:**
- Regulatory Compliance Status: FIA reporting compliance
- System Performance: Processing latency, uptime, error rates
- Audit Log Summary: Key activities and access patterns
- Recommendations: Process improvements, rule adjustments

---

## 7. Success Criteria & Metrics

### 7.1 Functional Success Criteria

- [ ] All transactions processed and analyzed in real-time (< 2 seconds)
- [ ] LCT threshold (UGX 20,000,000) correctly identified and flagged
- [ ] Suspicious activity patterns detected with > 80% accuracy rate
- [ ] Baseline behavior established for all active members within 90 days of go-live
- [ ] Risk scores calculated and updated for all flagged activities
- [ ] Alerts generated and routed to compliance team as configured
- [ ] Investigation workflow functional with full case tracking
- [ ] LCT reports generated automatically and submitted to FIA on schedule
- [ ] Audit trail complete and auditable for all system activities
- [ ] Report generation and export to FIA-required formats working

### 7.2 Performance Success Criteria

- [ ] System processes minimum 100,000 transactions/day without performance degradation
- [ ] Database query response time < 3 seconds for standard reports
- [ ] System uptime ≥ 99.5% during business hours
- [ ] Backup and disaster recovery procedures tested and validated

### 7.3 Compliance Success Criteria

- [ ] All regulatory requirements of AML Act, 2013 met
- [ ] FIA reporting obligations met 100% of the time
- [ ] External compliance audit passed (if applicable)
- [ ] Staff training completed for all users
- [ ] Documentation complete and audit-ready

### 7.4 Operational Success Criteria

- [ ] Compliance team trained and proficient with system
- [ ] Procedures documented and followed consistently
- [ ] User adoption > 95% within 3 months
- [ ] System support processes established and documented

---

## 8. Implementation Approach & Timeline

### 8.1 Phase 1: Foundation (Weeks 1-4)

- Requirements review and finalization
- System design and architecture review
- Database schema design
- Integration planning with existing City SACCO System

**Deliverables:**
- Final technical design document
- Database schema documentation
- Integration API specifications

### 8.2 Phase 2: Development (Weeks 5-12)

- Core transaction monitoring engine development
- Member profile and baseline module development
- Alert generation and management module
- Investigation & case management module

**Deliverables:**
- Core system modules (code + unit tests)
- API documentation
- Internal QA sign-off

### 8.3 Phase 3: Compliance & Reporting (Weeks 13-16)

- LCT and SAR report generation module
- Regulatory compliance verification
- Report submission workflows
- Audit logging and trail implementation

**Deliverables:**
- Report generation module
- FIA report format specifications
- Compliance documentation

### 8.4 Phase 4: Integration & Testing (Weeks 17-20)

- System integration with City SACCO components
- User acceptance testing (UAT)
- Security testing and penetration testing
- Performance and load testing

**Deliverables:**
- UAT sign-off document
- Security assessment report
- Performance benchmarks

### 8.5 Phase 5: Deployment & Training (Weeks 21-24)

- Production deployment
- Data migration and verification
- Staff training (compliance officers, admins, auditors)
- Go-live support

**Deliverables:**
- Deployment checklist and sign-off
- Training materials and completion records
- Go-live support plan

### 8.6 Phase 6: Stabilization & Optimization (Weeks 25-28)

- Post-go-live monitoring and support
- Performance tuning
- Rule optimization based on live data
- Ongoing compliance validation

**Deliverables:**
- Stabilization report
- Optimized configuration recommendations
- Ongoing support procedures

---

## 9. Risk Assessment & Mitigation

### 9.1 Key Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|-----------|
| Integration challenges with existing systems | High | Medium | Early integration planning, API design review, phased integration testing |
| High false positive rate | Medium | Medium | Extensive rule tuning during UAT, compliance officer feedback loops |
| Performance degradation with transaction volume | High | Low | Load testing, database optimization, scalable architecture design |
| Delayed FIA reporting | High | Low | Automated scheduling, multiple submission verification, backup manual process |
| Staff resistance to new system | Medium | Medium | Comprehensive training, phased rollout, compliance leadership sponsorship |
| Data quality issues in source systems | Medium | Medium | Data validation rules, cleansing procedures, pre-go-live data audit |
| Regulatory requirement changes | Medium | Low | Modular architecture, configuration-driven rules, change management process |

---

## 10. Assumptions & Constraints

### 10.1 Assumptions

- Existing City SACCO System can provide real-time transaction feed
- Member KYC data is reasonably complete and current
- 90-day historical transaction data available at go-live for baseline establishment
- Compliance team has dedicated resources for investigation and reporting
- FIA report format remains stable during implementation

### 10.2 Constraints

- Implementation timeline: Maximum 7 months (28 weeks)
- Budget: [To be defined]
- Technology stack: Consistent with existing City SACCO System architecture
- Regulatory changes: May require scope adjustments if AML Act amendments occur during implementation

---

## 11. Approval & Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Compliance Officer | | | |
| Operations Manager | | | |
| IT Manager | | | |
| Executive Sponsor | | | |

---

## Appendix A: Definitions & Terminology

- **AML:** Anti-Money Laundering
- **FIA:** Financial Intelligence Authority
- **LCT:** Large Cash Transaction
- **SAR:** Suspicious Activity Report
- **KYC:** Know Your Customer
- **PII:** Personally Identifiable Information
- **Risk Score:** Numeric rating (1-100) indicating risk level of transaction/activity
- **Structuring:** Pattern of making multiple transactions to avoid threshold reporting
- **Baseline:** Established normal behavior pattern for comparison

---

## Appendix B: References

1. Anti-Money Laundering Act, 2013 (as amended)
2. Financial Intelligence Authority Guidance on LCT Reporting
3. City SACCO System Technical Architecture Documentation
4. Compliance Procedures Manual

---

**Document Control:**
- Version 1.0 - Initial Requirements - April 15, 2026
- Status: Draft for Review
