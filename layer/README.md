# Climate-adaptation lending layer

The first part of the ARCAFIM pilot (concept note "AI Climate-Adaptation Lending Layer for ARCAFIM Partner SACCOs and MFIs"; build plan in the project, `claude/arcafim-pilot-build-plan.md`). It tags each new loan against the climate-adaptation taxonomy, so a SACCO can show which of its loans qualify and report on them.

## How it works

1. A member applies for a loan in the core banking system.
2. The platform sends its `LOAN_CREATED` webhook, signed, to the layer. The layer checks the signature, answers 202 at once, and tags the loan straight after, so a slow model never runs into the platform's 10-second webhook timeout.
3. The layer reads the loan through the platform's API with its own narrow API key.
4. It classifies the loan's purpose against the taxonomy. A model sees only the purpose (and the notes only with `ARCAFIM_INCLUDE_NOTES=on`), with the member's names, phone numbers, e-mail addresses and ID, passport and PIN numbers removed.
5. It writes the result back to the loan, as the `_arcafim` custom field set:
   - category, eligibility, confidence and a one-line reason;
   - who tagged it and the taxonomy version.
6. The review fields (`Review`, `Reviewed by`) are left empty for credit staff. A tag with no review is awaiting review, and only a reviewed tag counts.
7. A daily catch-up run (`backbook`) tags any loan whose tagging failed.

The layer keeps no data of its own. The tags live on the loans, where credit staff see them, reports and views can use them, and the platform's audit trail records them. It talks to the core banking system only through the API and webhooks, so a SACCO on another system needs only another adapter (`src/adapters/`).

| Part | File |
| --- | --- |
| Taxonomy (draft until Equity Bank's is shared) | `config/arcafim-taxonomy.json`, `src/taxonomy.js` |
| Redaction before anything reaches a model | `src/redact.js` |
| Classifiers: keyword (no model), Claude (Anthropic Messages API, keyword fallback) | `src/classifiers/` |
| Tagging rules: idempotent, never overwrites a reviewed tag | `src/tagger.js` |
| The City SACCO platform adapter | `src/adapters/citySacco.js` |
| Webhook signature check | `src/webhook.js` |
| HTTP service (`POST /hooks/loans`, `GET /health`) | `src/server.js` |
| Setup, single loans and the back book | `bin/layer.js` |

## Rules it keeps

- **Human decision:**
  - a tag is a suggestion until a credit officer reviews it;
  - the layer never writes the review fields, and checks again just before each write, so a review made while it was classifying is kept;
  - a reviewed tag is never overwritten;
  - Kenya's Data Protection Act 2019, section 35, limits decisions based solely on automated processing.
- **Data minimisation:** a model sees the redacted purpose only, by default.
  - Redaction removes what the member record knows (the member's names) and the number formats above.
  - It cannot know a guarantor's or relative's name written in the notes, which is why notes stay out by default.
- **Least privilege:** two API keys.
  - **The setup key** makes the fields and the webhook. Set its consumer to inactive after setup, and back to active when the taxonomy changes.
  - **The running key** reads loans and members and writes loan fields. Its `EDIT_LOAN_ACCOUNT` permission is wider than the layer uses (it would also allow editing a loan's own details), so the key is kept in Secret Manager and nowhere else.
- **Retries:** a retried or resent event changes nothing. A loan whose tagging failed is logged (`[tag-failed]`) and picked up by the daily catch-up.
- **No default model:** the model is chosen deliberately (`ARCAFIM_MODEL`) and its name is written on every tag it makes. If the model fails or answers outside the taxonomy, the keyword classifier answers instead and the reason says so.

## Settings

| Setting | What it is |
| --- | --- |
| `PLATFORM_URL` | The platform's address, for example `https://app.yourdomain.co.ke` |
| `PLATFORM_TENANT` | The SACCO's slug |
| `PLATFORM_API_KEY` | The layer's API key (Secret Manager) |
| `WEBHOOK_SECRET` | The webhook's signing secret, printed once by `setup` (Secret Manager) |
| `CLASSIFIER` | `keyword` (default) or `claude` |
| `ANTHROPIC_API_KEY` | With `CLASSIFIER=claude` (Secret Manager) |
| `ARCAFIM_MODEL` | With `CLASSIFIER=claude`: a model ID from the [Claude models page](https://docs.claude.com/en/docs/about-claude/models) |
| `ARCAFIM_MODEL_TIMEOUT_MS` | Default 15000; the webhook is answered before the model is called |
| `ARCAFIM_INCLUDE_NOTES` | `on` to send the loan's notes (redacted) to the model too; off by default |
| `PLATFORM_TIMEOUT_MS` | Default 5000, for each call to the platform |
| `TAXONOMY_FILE` | Another taxonomy file, for example Equity's when it arrives |

## Setting it up for a SACCO

1. **Make two API consumers** in the SACCO's console (Administration > Access > API Consumers), each with an API key:
   - **setup:** `VIEW_CUSTOM_FIELD`, `CREATE_CUSTOM_FIELD`, `EDIT_CUSTOM_FIELD`, `CREATE_COMMUNICATION_TEMPLATES`;
   - **running:** `VIEW_LOAN_ACCOUNT_DETAILS`, `EDIT_LOAN_ACCOUNT`, `VIEW_CLIENT_DETAILS` (the member's names, only to remove them).
2. **Deploy the layer** as its own Cloud Run service, from the repository root, with the secrets in Secret Manager:
   ```
   gcloud run deploy sacco-climate-layer --source layer --region europe-west1 \
     --allow-unauthenticated --no-cpu-throttling --min-instances 0 --max-instances 1 \
     --set-env-vars PLATFORM_URL=https://<platform address>,PLATFORM_TENANT=<slug>,CLASSIFIER=keyword \
     --set-secrets PLATFORM_API_KEY=climate-layer-api-key:latest,WEBHOOK_SECRET=climate-layer-webhook-secret:latest
   ```
   - `--allow-unauthenticated`: the platform's webhook carries no Google identity; the signature check is the gate.
   - `--no-cpu-throttling`: tagging runs after the answer.
   - With `CLASSIFIER=claude`, also set `ARCAFIM_MODEL` and the secret `ANTHROPIC_API_KEY`.
3. **Run setup** with the setup key:
   ```
   PLATFORM_API_KEY=<setup key> node bin/layer.js setup --url https://<layer address>/hooks/loans
   ```
   Store the signing secret it prints as `WEBHOOK_SECRET`. Then delete the setup consumer, or set it to inactive.
4. **Set the running key** as `PLATFORM_API_KEY` and redeploy.
5. **Tag the existing agricultural loans**:
   ```
   node bin/layer.js backbook --status ACTIVE,APPROVED --products <the agri product IDs>
   ```
6. **Schedule the daily catch-up** as a Cloud Run job with Cloud Scheduler, like the platform's jobs:
   ```
   node bin/layer.js backbook --status PARTIAL_APPLICATION,PENDING_APPROVAL,APPROVED
   ```
   It tags only loans that are untagged or tagged under an older taxonomy.

## When the taxonomy changes

1. Replace `config/arcafim-taxonomy.json`, or point `TAXONOMY_FILE` at the new file, with a new `version`.
2. Run `setup` again to add the new categories to the field options. Old options stay, so old tags remain valid.
3. Run `backbook`: loans tagged under the old version and not yet reviewed are tagged again. Reviewed tags stay as they are.

## Tests

`npm test` (or `node test/layer.test.js`) runs the layer against a real platform in-process. It needs the platform's database settings (`platform/.env`) and `platform/node_modules`. The model classifier is tested against a stand-in for the Messages API, so no key is needed.

CI runs it two ways:
- **`.github/workflows/layer.yml`:** when only `layer/` changes. It tests and deploys nothing.
- **The platform's own workflow:** whenever the platform changes, so an API change that breaks the layer is caught there.

## Next (pilot months 2 to 6)

- **Review app:** a tab on the loan page where credit staff confirm or correct the tag. This is how the 90% accuracy target is measured.
- **Impact reporter:** the monthly report by gender, age band, county, category and repayment status, in Equity's and IFAD's template.
- **In the platform:**
  - member county as data;
  - a rule refusing approval of an ARCAFIM-product loan until it is tagged eligible.
- **Scoring and member advisory:** later in the pilot.
