# Portfolio demo login

The ERP deliberately does not ship a shared production password. For a local portfolio demo, copy `.env.example` to `.env`, point `DATABASE_URL` at a disposable MySQL database, and choose credentials during the first setup screen.

Recommended disposable demo values:

```env
AUTH_USERNAME=demo
AUTH_PASSWORD=choose-a-local-demo-password
WHATSAPP_ENABLED=false
```

Do not reuse the shop login, commit a password, or enable the WhatsApp worker in a public portfolio deployment. The public demo should contain only seeded sample data and a non-production business profile.
