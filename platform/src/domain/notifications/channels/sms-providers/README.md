# SMS providers

A provider connects the SMS channel (`../sms.js`) to one kind of gateway. The platform ships one, `http.js`, a generic HTTPS gateway described by fields. Most aggregators can be set up with it from Administration > SMS > Settings, with no code.

A gateway that needs code (a signature over the request, a token exchange, a protocol other than HTTPS) gets a provider of its own. Write a module with the interface below and add it to `PROVIDERS` in `index.js`. Nothing else changes: the dispatcher, templates, subscriptions, the console and the communication log work with any provider.

## Interface

```js
module.exports = {
  name: 'Example gateway',            // shown in the settings form
  description: 'One sentence.',
  fields: [                           // the settings form, in order
    { name: 'url', label: 'Gateway URL (https)', required: true },
    { name: 'region', label: 'Region', options: ['EU', 'AF'], default: 'AF' },
    { name: 'apiKey', label: 'API key', secret: true },   // the one secret: sealed, never returned
  ],

  // Check the fields (the body of PUT /api/notificationsettings/sms) and return the
  // ones to store, without the secret. Throw err('A_CODE: ...') for a bad value.
  validate(body) { return { url, region }; },

  // The stored fields to show (never the secret).
  describe(settings) { return { url: settings.url, region: settings.region }; },

  // What the stored secret belongs to. When this changes, the secret must be typed
  // again, so it is never sent to a server it was not given for.
  server(settings) { return new URL(settings.url).origin; },

  // Send one message. `to` is E.164 (+254712345678); `from` is the SACCO's sender ID;
  // `id` is the platform's key for the message (send it as the client reference when
  // the gateway takes one). Never throw: return one of
  //   { ok: true, providerMessageId }
  //   { ok: false, reason, cause, permanent }
  // reason is INVALID_SMS_GATEWAY_CREDENTIALS or SMS_GATEWAY_ERROR. permanent: true
  // fails the message at once; false retries it on the webhook schedule.
  async send(settings, secret, { to, text, from, id }) { ... },

  // Optional: read a delivery report the gateway posts to the address made in the
  // settings. `report` is { body, query } (JSON or form). Return
  //   [{ providerMessageId, status: 'DELIVERED' | 'UNDELIVERED' | null, detail }]
  parseDeliveryReport(settings, report) { ... },
};
```

## Rules a provider keeps

- **Outbound requests:** go through `src/lib/outbound.js` (`checkUrl` and `send`), so a tenant cannot make the platform call a private address.
- **The secret:** never put it in a URL, an error message or a log line.
- **Answers:** keep a short excerpt of the gateway's answer in `cause`. It is shown in the communication log.
- **Tests:** add checks to `test/sms.test.js` against a gateway run inside the test.
