# Wakandi Member App — Signup Flow Specifications

## Executive Summary

Wakandi is a mobile-first SACCO (savings and credit cooperative organization) member application featuring a streamlined 8-step signup journey with support for multiple authentication paths, ID verification, OTP validation, and secure PIN creation. The prototype supports bilingual interface (English/Swahili) and demonstrates critical user flows including account recovery, application resumption, and error states.

---

## User Flow & State Diagrams

### Primary Signup Flow (8 Steps)

```
┌─────────────┐
│  1. Login   │ (Phone-first entry)
└──────┬──────┘
       │ "Join one now" / "Get started"
┌──────▼──────┐
│  2. Register│ (Phone validation, 12% progress)
└──────┬──────┘
       │
┌──────▼─────────────┐
│  3. Join a SACCO   │ (Educational screen: wealth building)
└──────┬──────────────┘
       │ (2 paths: questionnaire or manual)
┌──────▼────────────┐
│  4. Pick SACCO    │ (Searchable list, pre-selected default)
└──────┬────────────┘
       │
┌──────▼──────────────┐
│  5. Verify ID       │ (ID type, number, full name - 40% progress)
└──────┬──────────────┘
       │
┌──────▼─────────────┐
│  6. OTP Validation │ (6-digit SMS code - 60% progress)
└──────┬─────────────┘
       │
┌──────▼──────────────┐
│  7. Create PIN      │ (4-digit PIN, on-screen keypad - 80% progress)
└──────┬──────────────┘
       │
┌──────▼──────────┐
│  8. Success      │ (Application submitted, SMS approval pending)
└─────────────────┘
```

### Alternate Branches

**A. Application Found Modal** (When returning member detected)
```
Login → [Phone detected as existing member]
     → Modal: "Application found! 😊"
     → Options: [Continue Application] [Cancel Application]
     → Continue → Steps 5-8
     → Cancel → Step C
```

**B. Forgot PIN Path** (Existing member reset flow)
```
Login → [Member detected] → Verify ID (Steps 5-8 with PIN reset context)
```

**C. Cancel Application**
```
AppFound Modal → [Cancel selected]
              → Verify ID confirmation (ID validation step)
              → Return to Login
```

**D. OTP Error State** (Invalid code entered)
```
OTP Step → [Wrong code entered]
        → Error animation (shake) + "Invalid code" message
        → [Retry] or [Resend code]
        → Timer: "Resend in X:XX"
```

### State Machine

```
STATE = {
  current: "login" | "register" | "joinSacco" | "pickSacco" | 
           "verifyId" | "otp" | "pin" | "success" |
           "appFound" | "forgotPin" | "cancelApp" | "otpError"
}

LANGUAGE = "en" | "sw"
```

---

## UI Component Specifications

### 1. **Header (hdr)**
- Brand logo + "WAKANDI" text (teal color, 20px font, 800 weight)
- Language toggle (EN/SW buttons, pill-shaped, teal active state)
- Fixed max-width: 1180px
- Padding: 24px

### 2. **Device Frame (device)**
- iPhone mockup: 360px × 740px
- Dark background (#111), 44px border-radius
- Status bar included (9:41 time display, signal/wifi icons)
- Safe area: notch at top (100px × 22px black pill)
- Box shadow: drop shadow (30px blur, 10,94,99 dark teal at 25% opacity)

### 3. **Screen Content (screen)**
- Full-bleed white background (border-radius: 34px)
- Flexbox column layout
- Overflow-y: auto for scrolling
- Three sections: statusbar, content, safebot

### 4. **Hero Section (hero)**
- Teal gradient: 150deg from #0E7D83 → #0A5E63
- Yellow accent circles (background shapes for visual interest)
- H1: 22px, 800 weight, yellow color (#FCCE2A)
- Paragraph: 13px, 92% opacity white
- Padding: 0 24px 36px

### 5. **Card Container (card)**
- White background, 20px padding
- Title: 18px, 800 weight, teal ink
- Subtitle: 13px, muted gray, 1.5 line-height

### 6. **Input Fields (input)**
- Flexbox row, 12px gap
- Border: 1.5px solid #E1EBEA
- Border-radius: 14px
- Padding: 12px 14px
- Font: 15px, inherit family
- Focus state: teal border (transition 0.15s)
- Variants:
  - **Text input**: placeholder="712 345 678" (phone)
  - **Select**: National ID, Passport, Alien ID
  - **Flag icon**: Kenyan flag (red-black-green stripes)

### 7. **Buttons (btn)**
- Width: 100%, padding: 14px, border-radius: 14px
- Font: 15px, 700 weight, inherit family
- Variants:
  - **Primary**: Teal background, white text, hover darkens to #0A5E63
  - **Ghost**: Transparent, teal text, teal border (1.5px)
  - **Disabled**: Muted teal (#B7D6D5), cursor: not-allowed
  - **Active state**: Scale 0.98 (touch feedback)

### 8. **Progress Bar (progress)**
- Height: 4px, mint background (#EDF7F3)
- Inner span: teal fill, animated width transition (0.3s)
- Widths: 12% (register), 40% (verifyId), 60% (otp), 80% (pin)

### 9. **SACCO Cards (sacco-card)**
- Horizontal layout: logo (40px square) → info → chevron
- Border: 1px solid #E1EBEA
- Padding: 14px
- Border-radius: 14px
- Hover: teal border, mint background, translateY(-1px)
- Logo: Colored square (40×40) with tag letter (U, H, M, D)
- Info:
  - Name: 14px, 700 weight
  - Meta: 12px, muted gray
- Active state: "SELECTED" yellow tag

### 10. **OTP Input Boxes (otp .box)**
- Grid: 6 boxes, 44px × 54px
- Border: 1.5px solid #E1EBEA
- Border-radius: 12px
- Font: 22px, 800 weight
- Variants:
  - **Filled**: Teal border, teal text, mint background
  - **Empty**: Standard border, white background
  - **Error**: Red border, red text, #FEECE8 background + shake animation (0.3s)

### 11. **PIN Dots (pin-dots)**
- Flex row, 16px gap
- Dots: 16px circle, 2px border, standard border color
- Active: Teal fill and border
- Shows progress (e.g., 3 of 4 filled)

### 12. **Keypad (keypad)**
- 3×4 grid: keys 1-9, blank, 0, backspace
- Each key: 16px padding (vertical), 14px border-radius
- Hover: darker mint (#D7ECE4)
- Backspace (⌫): Transparent background, red text
- Empty cells: visibility: hidden

### 13. **Success Check Icon (check)**
- 88px circle, teal background
- White checkmark SVG centered
- Box shadow: 14px blur, 30px spread, teal at 30% opacity
- Margin: 30px auto 18px

### 14. **Modal Overlay & Modal (modal-overlay, modal)**
- Overlay: Absolute inset 0, dark teal at 55% opacity, backdrop blur 4px
- Modal: 
  - Gradient: 135deg from #4C5BD4 → #7B4CD4 (purple)
  - Border-radius: 24px
  - Padding: 28px 22px
  - White text
  - Shadow: 20px blur, 50px spread, purple at 40% opacity
  - H3: 18px, 800 weight
  - P: 13px, 90% opacity
  - Button: White background, teal text
  - Cancel link: White, underlined, 13px

### 15. **Screen Head (screenhead)**
- Flex between title and close button
- Border-bottom: 1px solid #E1EBEA
- Padding: 14px 20px
- Font: 15px, 800 weight
- Close button: 30px circle, border, muted color, cursor: pointer

### 16. **Help Note (help-note)**
- Background: #FFF7D6 (pale yellow)
- Border: 1px solid #F1DF8A
- Color: #6B5A00 (dark brown)
- Padding: 12px
- Border-radius: 12px
- Font: 12px, 1.5 line-height

### 17. **Footer (foot)**
- Margin-top: auto
- Padding: 16px 24px 20px
- Text-align: center
- Color: muted gray
- Links: Teal, 700 weight, no underline

### 18. **Flow Navigation (flow-nav)**
- Position: sticky (top: 16px)
- Background: white
- Border: 1px solid #E1EBEA
- Border-radius: 20px
- Padding: 16px
- List items: Flex, 13px, 600 weight, gap: 10px
- Active item: Teal background, white text, rounded
- Number badge: 22px circle, background mint-2, teal text
- Done items: Teal badge with white number

### 19. **Notes Panel (notes)**
- Background: white
- Border: 1px solid #E1EBEA
- Border-radius: 20px
- Padding: 20px
- H3: 15px, margin bottom 8px
- UL: Standard list styling, muted color
- Contains keyboard hint: `.kbd` with mint background, teal text

---

## API/Contract Specifications

### Request/Response Protocol

#### 1. **Phone Lookup & Validation**
```
POST /api/members/lookup
{
  "phoneNumber": "+254712345678"
}

Response (200):
{
  "found": true,
  "memberId": "61110K134",
  "hasActiveApplication": false,
  "status": "ACTIVE" | "INACTIVE" | "SUSPENDED"
}

Response (404):
{
  "found": false,
  "suggestRegister": true
}
```

#### 2. **Register New Member**
```
POST /api/members/register
{
  "phoneNumber": "+254712345678"
}

Response (201):
{
  "memberId": "TMP_UUID",
  "status": "REGISTRATION_STARTED",
  "step": 2,
  "expiresAt": "2026-04-25T12:00:00Z"
}
```

#### 3. **SACCO List**
```
GET /api/saccos?filter=active

Response (200):
{
  "saccos": [
    {
      "id": "sacco_1",
      "name": "Uzima SACCO",
      "location": "Nairobi",
      "memberCount": 12400,
      "color": "#FCCE2A",
      "tag": "U"
    },
    // ... more saccos
  ]
}
```

#### 4. **SACCO Selection**
```
POST /api/applications/{applicationId}/select-sacco
{
  "saccoId": "sacco_4",
  "phoneNumber": "+254712345678"
}

Response (200):
{
  "applicationId": "APP001",
  "saccoId": "sacco_4",
  "step": 4,
  "progress": 35
}
```

#### 5. **ID Verification**
```
POST /api/applications/{applicationId}/verify-id
{
  "idType": "NATIONAL_ID" | "PASSPORT" | "ALIEN_ID",
  "idNumber": "12345678",
  "fullName": "Jane Mwangi"
}

Response (200):
{
  "verified": true,
  "applicationId": "APP001",
  "step": 5,
  "progress": 40,
  "otpSent": true,
  "maskedPhone": "+254 712 345 ***"
}

Response (400):
{
  "verified": false,
  "error": "ID_NOT_FOUND" | "INVALID_FORMAT" | "NAME_MISMATCH",
  "message": "ID verification failed. Please check and try again."
}
```

#### 6. **OTP Verification**
```
POST /api/applications/{applicationId}/verify-otp
{
  "code": "391048"
}

Response (200):
{
  "verified": true,
  "applicationId": "APP001",
  "step": 6,
  "progress": 60
}

Response (400):
{
  "verified": false,
  "error": "INVALID_CODE" | "EXPIRED" | "TOO_MANY_ATTEMPTS",
  "retriesRemaining": 2
}
```

#### 7. **PIN Creation**
```
POST /api/applications/{applicationId}/create-pin
{
  "pin": "1234"
}

Response (201):
{
  "applicationId": "APP001",
  "pinCreated": true,
  "step": 7,
  "progress": 80
}
```

#### 8. **Application Submission**
```
POST /api/applications/{applicationId}/submit
{
  "phoneNumber": "+254712345678"
}

Response (200):
{
  "applicationId": "APP001",
  "status": "PENDING_APPROVAL",
  "step": 8,
  "progress": 100,
  "expectedApprovalDays": 2,
  "message": "Your application has been submitted. You'll get an SMS once an officer approves your membership."
}
```

### Error Response Format

```
{
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "field": "fieldName (optional)",
  "timestamp": "2026-04-23T10:30:00Z"
}
```

### Status Codes
- **200**: Successful operation
- **201**: Resource created
- **400**: Validation error (invalid input, business rule violation)
- **404**: Resource not found (member, application, SACCO)
- **409**: Conflict (duplicate application, already a member)
- **429**: Rate limit exceeded (too many OTP attempts)
- **500**: Server error

---

## Requirements & Acceptance Criteria

### Functional Requirements

#### FR-1: Phone-First Login/Register
- **Requirement**: System accepts Kenyan phone numbers (+254 format or 0 prefix)
- **Acceptance Criteria**:
  - Phone input accepts 10-digit format (712345678)
  - System validates country code (+254)
  - Accepts registered members and new signups from same screen
  - Shows contextual label ("Welcome back" vs "Get started")

#### FR-2: Bilingual Interface
- **Requirement**: Full English (EN) and Swahili (SW) support
- **Acceptance Criteria**:
  - Language toggle in header switches all UI text instantly
  - No page reload required
  - Default language: English
  - All 30+ strings localized (see window.__STR object)

#### FR-3: SACCO Selection
- **Requirement**: Members choose from available SACCOs
- **Acceptance Criteria**:
  - Display list of active SACCOs with logo, name, location, member count
  - Live search (case-insensitive substring match)
  - Empty state messaging: "Oh no! This cooperative isn't available yet."
  - Pre-select Demo SACCO (for testing)
  - Show "Can't find your cooperative?" help note with recommendation CTA

#### FR-4: ID Verification
- **Requirement**: Capture and validate ID during onboarding
- **Acceptance Criteria**:
  - Support three ID types: National ID, Passport, Alien ID
  - Require ID number (8+ digits)
  - Require full name (must match ID in backend)
  - Show progress bar at 40%

#### FR-5: OTP Validation
- **Requirement**: SMS one-time password verification
- **Acceptance Criteria**:
  - Display 6 input boxes for OTP code
  - Show masked phone number: "+254 712 345 ***"
  - 2-minute expiry countdown timer
  - "Resend in X:XX" label
  - Error state: shake animation + red text + "Invalid code. Please try again."
  - Support resend after first attempt expires

#### FR-6: PIN Creation
- **Requirement**: 4-digit PIN for account security
- **Acceptance Criteria**:
  - On-screen numeric keypad (1-9, 0, backspace)
  - Show PIN entry progress (dots: empty → filled)
  - Red backspace button (#D94A2E)
  - Auto-advance to success after 4 digits entered

#### FR-7: Application Status Tracking
- **Requirement**: Show approval workflow step and progress
- **Acceptance Criteria**:
  - Progress bar increases: 12% → 40% → 60% → 80% → 100%
  - Success screen: "Application has been submitted"
  - Message: "You'll get an SMS once an officer approves"
  - CTA: "Go to my dashboard"

#### FR-8: Account Recovery Flows
- **Requirement**: Support existing members with incomplete applications
- **Acceptance Criteria**:
  - Detect returning member by phone number
  - Show modal: "Application found! 😊"
  - Options: "Continue application" or "Cancel application"
  - Forgot PIN path: Skip to ID verification
  - Cancel app: Require ID verification for security

#### FR-9: Device UI Responsiveness
- **Requirement**: Mock iPhone frame display
- **Acceptance Criteria**:
  - Render 360px × 740px device frame
  - Show status bar (time, signal, battery)
  - Safe area notch at top
  - Device controls: Back, Next, Reset buttons

#### FR-10: Navigation Flow
- **Requirement**: Smooth transitions between signup steps
- **Acceptance Criteria**:
  - Left arrow/back button: Previous step
  - Right arrow/next button: Forward step
  - Reset button: Return to login
  - Click nav items: Jump directly to that step
  - Left panel shows progress (active step highlighted)

### Non-Functional Requirements

#### NFR-1: Performance
- Step transitions must complete < 300ms
- API responses: < 1s
- No layout shift during language switch

#### NFR-2: Accessibility
- Form labels visible and associated with inputs
- Color contrast: WCAG AA (4.5:1 for text)
- Error messages clear and actionable
- Keyboard navigation support (Tab, Enter, arrow keys)

#### NFR-3: Security
- PIN encrypted in transit (HTTPS only)
- OTP codes never logged or displayed in console
- Phone numbers masked in UI
- Session expiry: 30 minutes
- Rate limit OTP attempts: 3 per 15 minutes

#### NFR-4: Browser Compatibility
- Chrome/Firefox/Safari (latest 2 versions)
- Mobile browsers (iOS Safari, Chrome Mobile)
- No external dependencies (vanilla JS)

#### NFR-5: Localization
- String keys mapped to translations
- Date/time formatting per locale
- Number formatting (if applicable)
- RTL support (future: Arabic)

---

## Implementation Details

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JavaScript (ES6+), HTML5, CSS3 |
| State Management | Window object (global state, no framework) |
| Data Binding | Template literals + DOM innerHTML |
| Navigation | Function-based routing (no URL hash changes) |
| Styling | CSS variables for theming |
| Localization | Embedded string map (window.__STR) |

### Key Data Structures

#### Application State
```javascript
window.__STATE = {
  current: "login" // Current screen ID
}

window.__LANG = "en" // Current language
```

#### Flow Definition
```javascript
window.__FLOW = [
  {
    id: "login",
    title: "1. Login",
    note: "Phone-first login..."
  },
  // ... 8 steps
]

window.__BRANCHES = [
  { id: "appFound", title: "A. Application found modal", ... },
  // ... 4 branches
]
```

#### SACCO Catalog
```javascript
window.__SACCOS = [
  {
    name: "Uzima SACCO",
    meta: "Nairobi · 12,400 members",
    tag: "U",
    color: "#FCCE2A",
    ink: "#1C2B2D",
    active: false
  },
  // ... more saccos
]
```

#### Localization Map
```javascript
window.__STR = {
  en: {
    loginTitle: "Karibu back to<br>your cooperative",
    loginSub: "Welcome back, we missed you.",
    // ... 30+ keys
  },
  sw: {
    loginTitle: "Karibu tena kwenye<br>chama chako",
    // ... swahili translations
  }
}
```

### Core Functions

#### `nav(id)`
- Purpose: Navigate to screen by ID
- Renders screen template (from window.__SCREENS[id])
- Updates flow nav highlight
- Updates notes panel
- Resets scroll to top

#### `filterSaccos(q)`
- Purpose: Live search SACCOs
- Filters by substring match (case-insensitive)
- Shows empty state if no matches
- Highlights active SACCO

#### `renderNav()`
- Purpose: Update left navigation panel
- Marks current step as active
- Marks completed steps as done
- Updates branch navigation

#### `renderNote()`
- Purpose: Update notes panel on right
- Displays step title and description
- Shows keyboard shortcut hints

### Screen Template Structure

Each screen is a function returning HTML string:
```javascript
window.__SCREENS = {
  "login": () => `<div class="statusbar">...</div>...<div class="safebot"></div>`,
  // ... other screens
}
```

Screens include:
- Statusbar (time, signal icons)
- Content (flex column, scrollable)
- Safebot (safe area indicator)
- Optional: progress bar, forms, cards, modals

### Event Handlers

| Event | Handler | Action |
|-------|---------|--------|
| Button click | `onclick="nav('...')"` | Navigate to screen |
| Keyboard arrow keys | Document keydown | Next/Previous step |
| Language toggle | `#lang` click | Switch language, re-render |
| Back button | `#back.onclick` | Previous step |
| Forward button | `#fwd.onclick` | Next step |
| Reset button | `#reset.onclick` | Return to login |
| Search input | `oninput="filterSaccos(...)"` | Filter SACCOs |
| Keypad button | `onclick` | PIN entry logic |

### Styling Architecture

#### CSS Variables (Color Palette)
```css
--w-teal: #0E7D83          /* Primary action color *)
--w-teal-dark: #0A5E63     /* Hover/pressed state *)
--w-teal-light: #1FA0A6    /* Alternative teal *)
--w-mint: #EDF7F3          /* Light background *)
--w-mint-2: #D7ECE4        /* Hover backgrounds *)
--w-yellow: #FCCE2A        /* Accent, tags *)
--w-red: #D94A2E           /* Error, destructive *)
--w-ink: #1C2B2D           /* Primary text *)
--w-muted: #6B7F80         /* Secondary text *)
--w-border: #E1EBEA        /* Borders *)
```

#### Responsive Breakpoints
- Mobile (360px): Base design
- Tablet (768px+): 3-column layout (nav, device, notes)
- Desktop (1180px): Full width with max-width container

### Animation & Transitions

| Element | Animation | Duration |
|---------|-----------|----------|
| Button active | scale(0.98) | 0.08s |
| Input focus | border-color teal | 0.15s |
| Progress bar | width | 0.3s |
| OTP error | shake (±4px) | 0.3s |
| SACCO hover | translateY(-1px) + color | 0.12s |

---

## Data Flow Diagram

```
┌─────────────────────┐
│   User Action       │ (Click button, input text, select SACCO)
└──────────┬──────────┘
           │
           ▼
    ┌──────────────┐
    │ Event Handler│ (onclick, oninput, etc.)
    └──────┬───────┘
           │
           ▼
    ┌─────────────────┐
    │ API Call (TBD)  │ (POST /api/verify-id, etc.)
    └──────┬──────────┘
           │
           ▼
    ┌──────────────────┐
    │ State Update     │ (window.__STATE.current = "otp")
    └──────┬───────────┘
           │
           ▼
    ┌──────────────────┐
    │ nav(screenId)    │ (Render new screen)
    └──────┬───────────┘
           │
           ▼
    ┌──────────────────────┐
    │ Update DOM           │ (innerHTML, renderNav, renderNote)
    └──────┬───────────────┘
           │
           ▼
    ┌──────────────────┐
    │ Browser Renders  │ (Paint, composite)
    └──────────────────┘
```

---

## Testing Strategy

### Unit Tests (Frontend Logic)
- Phone number validation (Kenyan format)
- SACCO filtering (case-insensitive search)
- Language switching (all strings populated)
- Navigation flow (valid step transitions)

### Integration Tests (API Mocking)
- Member lookup → register → select SACCO flow
- ID verification → OTP → PIN creation
- Error handling (invalid OTP, duplicate application)
- Application recovery (existing member path)

### UI/E2E Tests (Selenium/Cypress)
- Fill phone number → verify SMS sent
- Complete signup end-to-end
- Test all 8 steps + 4 branches
- Keyboard navigation (arrow keys)
- Language toggle persistence
- Mobile viewport (360px)

### Manual Testing Checklist
- [ ] Complete signup flow as new member
- [ ] Return to app → see "Application found" modal
- [ ] Try "Forgot PIN" path
- [ ] Test OTP error + retry
- [ ] Toggle language → verify all text
- [ ] Test search (find SACCO, empty state)
- [ ] Keyboard shortcuts (← → arrows, Reset)
- [ ] Mobile device (iPhone 12 mini: 360px)

---

## Future Enhancements

1. **Backend Integration**: Wire to real API endpoints
2. **Persistence**: Store application state (IndexedDB or server)
3. **Biometric Auth**: Fingerprint/Face ID after PIN
4. **Referral Code**: Support member referrals during signup
5. **Document Upload**: KYC document capture (ID photo, proof of address)
6. **Push Notifications**: Send approval status updates
7. **Analytics**: Track signup funnel drop-off points
8. **A/B Testing**: Test alternate flows (questionnaire recommendation vs manual search)
9. **Offline Support**: Service Worker for offline-first experience
10. **Accessibility**: Screen reader testing, keyboard navigation

---

## Glossary

| Term | Definition |
|------|-----------|
| SACCO | Savings and Credit Cooperative Organization (member-owned financial cooperative) |
| KYC | Know Your Customer (identity verification requirement) |
| OTP | One-Time Password (SMS code) |
| PIN | Personal Identification Number (4-digit account password) |
| Kwara ID | Unique member identifier (format: 61110KXXXX) |
| Application | Member signup submission awaiting officer approval |
| Hero | Large-format gradient header with brand messaging |
| CTA | Call-to-Action (primary button) |

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-23 | Claude | Initial specification from prototype |

