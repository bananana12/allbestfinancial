# Email Backend Setup

This folder now includes a small Node.js backend for the application form.

## How It Works

1. Customer submits the form on the website.
2. The browser sends the application to `POST /api/apply`.
3. `server.js` sends the application details by email through SMTP.
4. The email is delivered to `allbesthowly53@gmail.com`.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your real SMTP password into `SMTP_PASS`.
   - For Gmail, use a Gmail App Password.
   - Do not use your normal Gmail login password.
3. Run:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Important

If you open `test.html` by double-clicking the file, the form can only send email while this backend is also running on:

```text
http://localhost:3000
```

For a live website, upload/deploy `test.html`, `server.js`, `package.json`, and your private `.env` to a hosting service that supports Node.js.
