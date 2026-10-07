# Developer guide

This is for people who connect another system to a SACCO on this platform: a mobile app, a payment gateway, a data warehouse or an accounting tool. The README describes how the platform itself is built.

## 1. Where the API is

- **Base path:** every SACCO's API is under `/api` on the platform's address, for example `https://app.example.com/api`.
- **Choosing a SACCO:** a request says which one it is for in one of three ways, in this order:
  1. the token it carries, which names its SACCO;
  2. the subdomain (`citysacco.app.example.com`), for SACCOs whose slug has no underscore;
  3. the `X-Tenant` header (`X-Tenant: citysacco`).

  A token for one SACCO with another SACCO's subdomain or header is refused with 403.
- **Health checks:** `GET /healthcheck` answers `{"status": "UP"}` when the platform and its database answer. `GET /health` gives more detail for operators.

## 2. The sandbox

- **What it is:** each SACCO can have a sandbox, a second SACCO named `<slug>_sbx` (`citysacco_sbx`) on the same platform. It is empty, or a copy of production with members' personal data anonymized, or an exact copy.
- **Use it first:** build and test against the sandbox, then switch the `X-Tenant` (and the keys) to production.
- **Telling them apart:** every answer from a SACCO's API, once the SACCO is known, carries `X-Environment: PRODUCTION` or `X-Environment: SANDBOX`. Check it in tests so a test run never writes to production.
- **What a sandbox does not do:**
  - it sends no webhooks, email or SMS at first. Email and SMS need their settings entered again. Each webhook is switched off and keeps production's address, so point it at a test receiver before switching it on;
  - API keys are not copied into it, so make keys in the sandbox's own Access > API Consumers;
  - it is not backed up, so keep no real work there.
- **Who manages it:** the SACCO's administrators, from Administration > Sandbox (`GET /api/sandbox`, `POST /api/sandbox`, `POST /api/sandbox:reset`, `POST /api/sandbox:clone`, `DELETE /api/sandbox`).

## 3. Signing in

- **Systems:** use an API consumer and a key. An administrator makes the consumer in Access > API Consumers, gives it a role (what it may do) and makes a key, which is shown once. Send the key in the `apikey` header:

  ```
  GET /api/clients?limit=10
  X-Tenant: citysacco
  apikey: <the key>
  ```

  A consumer's role decides which routes it may call, branch by branch, like a staff user's. Keys can be revoked and replaced at any time.
- **People:** apps used by staff sign in with `POST /api/auth/login` (`{ "email", "password" }`) and get an `accessToken` (15 minutes) and a `refreshToken`. Send `Authorization: Bearer <accessToken>`, and renew with `POST /api/auth/refresh`. Some roles also need a second factor.
- **Basic authentication** with a user's password is not accepted.

## 4. Requests and answers

- **Format:** JSON in and out (`Content-Type: application/json`). Dates are `yyyy-MM-dd` in the SACCO's own calendar, and times are ISO 8601 in UTC.
- **Paging:** lists take `offset` (default 0) and `limit` (default 50, at most 1000). Add `paginationDetails=ON` to get the `items-offset`, `items-limit` and `items-total` headers.
- **Search:** many records have a `:search` route (`POST /api/clients:search`, `POST /api/deposits:search`) that takes `filterCriteria` and `sortingCriteria`.
- **Errors:** an error answers with an HTTP status and

  ```json
  { "errors": [ { "errorCode": 404, "errorReason": "CLIENT_NOT_FOUND" } ] }
  ```

  `errorReason` is a stable code. Sometimes a sentence follows the code after a colon; match on the code.
- **Retrying safely:** send an `Idempotency-Key` header (at most 128 characters) on a POST that moves money. Sending the same request again with the same key, after a timeout or a dropped connection, gets the first answer back instead of acting twice. The same key on a different request is refused with 409.
- **Editing configuration safely:** a GET of a loan or deposit product (`/api/loan-products/{id}`, `/api/deposit-products/{id}`), a transaction channel (`/api/organization/transactionChannels/{id}`) or a custom field definition (`/api/custom-fields/definitions/{id}`, `/api/customfields/{id}`) answers with an `ETag`, and so does a configuration file (`/api/configuration/*.yaml`). A custom field set's version is its `row_version` in the sets list: send `"v<row_version>"`. Send the tag back in `If-Match` on the PUT or PATCH (for a product's fees, the product's tag). Other answers carry an automatic `ETag` of their body, which `If-Match` does not accept. If someone changed the record since you read it, the answer is `412` with `PRECONDITION_FAILED`: read it again and repeat your change. Without `If-Match` the change goes through, as before.
- **Conflicts:** `409 CONFLICT_TRY_AGAIN` means the database ended your request to break a deadlock and the server's own retries did not get through. Nothing was saved; send the request again (with the same `Idempotency-Key` if it moves money).
- **Reports:** report answers carry `Data-As-At` (ISO 8601, UTC) and `Data-Source` (`primary`, or `replica` when the SACCO's reports are read from a copy of the database a moment behind).
- **Rate limits:** each SACCO has a number of requests a minute. Answers carry `x-ratelimit-limit` and `x-ratelimit-remaining`. Over the limit, the answer is 429 with `retry-after` in seconds.
- **Versions:** the API is not versioned. Changes keep old requests and fields working, and new fields may appear in answers at any time, so ignore fields you do not know.

## 5. Being told when something happens

- **Webhooks** (Administration > Webhooks): the platform sends a request to your HTTPS address when an event happens, such as a deposit, an approval or the end of day.
  - Only a `2xx` answer counts as delivered; anything else is retried for 24 hours.
  - Check `x-sacco-signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">` with the signing secret.
  - Remove duplicates with `x-notifications-idempotency-key`.
- **Event streams** (Administration > Events Streaming, `/api/v1/subscriptions`): subscribe to topics and read batches of events over HTTP at your own pace.
  - Commit cursors with the `X-Stream-Id` the stream gave you.
  - A stream ends after 55 seconds; reconnect and read on from your cursor.

## 6. Apps: showing your application in the back office

- **The definition:** an XML file, as on the reference platform:

  ```xml
  <application>
    <id>your-app</id>
    <name>Your app</name>
    <provider>Your company</provider>
    <description>What it does</description>
    <installURL>https://app.example.com/installed</installURL>
    <uninstallURL>https://app.example.com/uninstalled</uninstallURL>
    <extensionpoint>
      <location>CLIENT_VIEW</location>
      <label>Credit score</label>
      <url>https://app.example.com/client</url>
    </extensionpoint>
  </application>
  ```

  The locations are CLIENT_VIEW, GROUP_VIEW, LOAN_ACCOUNT_VIEW, DEPOSIT_ACCOUNT_VIEW, LINE_OF_CREDIT_VIEW, BRANCH_VIEW, CENTRE_VIEW, LOAN_PRODUCT_VIEW, DEPOSIT_PRODUCT_VIEW, USER_VIEW, REPORTING_VIEW and EXTENSION_MENU. Addresses must be HTTPS. No DOCTYPE or entities other than the five standard ones.
- **The App Key:** agree one (up to 32 characters) with the SACCO. Its administrator enters it in Administration > Apps.
- **What your page receives:** a form POST with one field, `signed_request`, which is `PART1.PART2`:
  - PART2 is the base64url of a JSON context: `algorithm` (`HMAC-SHA256`), `appId`, `tenantId`, `location`, `objectType`, `objectId`, `userId`, `userEmail`, `issuedAt` and `expiresAt` (Unix seconds), `nonce` and `apiBaseUrl`;
  - PART1 is the base64url of the HMAC-SHA256 of PART2 (the text as received) with the App Key.

  Check PART1 in constant time, refuse an expired context, and refuse a nonce you have seen. Only then trust the context.
- **Install and uninstall:** the same signed form post to `installURL` (with `event: INSTALLED`) and `uninstallURL` (`event: UNINSTALLED`). Answer `2xx` to an install, or it is cancelled.
- **Calling the API:** with the API key the SACCO gives you for the app's own API consumer, in the `apikey` header, at `apiBaseUrl` (the platform's configured public address; when it is null, ask the SACCO for the address).
- **Your page in a frame:** it is shown in a sandboxed frame that allows scripts, forms, popups and your own origin, but not navigating the back office. Allow being framed by the platform's address (`Content-Security-Policy: frame-ancestors`). Answer the signed POST at the extension point's own origin: a redirect to another origin is blocked.

## 7. A first request

1. **Get a key:** ask the SACCO's administrator for a sandbox API consumer with a role that may read clients, and its key.
2. **Check the platform answers:**

   ```
   curl https://app.example.com/healthcheck
   ```

3. **List some clients:**

   ```
   curl -H "X-Tenant: citysacco_sbx" -H "apikey: $KEY" "https://app.example.com/api/clients?limit=5&paginationDetails=ON" -i
   ```

   The answer should carry `X-Environment: SANDBOX` and `items-total`.
4. **Write something:** make a deposit with an `Idempotency-Key`, and watch it arrive on your webhook in the sandbox.
