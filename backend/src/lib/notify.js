// Email notifications - optional, off by default. Uses Gmail SMTP with an
// App Password (free, no new account needed if Akash already has Gmail) so
// he's pinged the moment a client submits a request instead of only finding
// out by opening the dashboard.
//
// Every exported function is designed to NEVER throw or reject: a
// misconfigured or down mail server must never break the request that
// triggered the notification. Configure via:
//   GMAIL_USER=youraddress@gmail.com
//   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   (Google Account -> Security ->
//     2-Step Verification -> App passwords - NOT your normal Gmail password)
//   NOTIFY_EMAIL=where-to-send@example.com   (optional, defaults to GMAIL_USER)
// Until GMAIL_USER and GMAIL_APP_PASSWORD are both set, every call here is a
// harmless no-op (logged, not sent).

let cachedTransporter = null;

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!cachedTransporter) {
    const nodemailer = require('nodemailer');
    cachedTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }
  return cachedTransporter;
}

async function sendNotificationEmail({ subject, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[notify] GMAIL_USER/GMAIL_APP_PASSWORD not set - skipping email: ${subject}`);
    return;
  }
  const to = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text,
    });
  } catch (e) {
    // Never let a mail failure affect the caller - just log it.
    console.error(`[notify] failed to send "${subject}":`, e.message);
  }
}

function notifyNewDraftRequest({ id, requestType, category, submittedBy, autoDrafted }) {
  const subject = `MMPL Dashboard: new ${requestType} request from ${submittedBy}`;
  const text = [
    `${submittedBy} submitted a new ${requestType} request${category ? ` (${category})` : ''} on the MMPL dashboard.`,
    autoDrafted
      ? 'It was auto-drafted via Gemini and delivered immediately - please review it in the Client Requests tab when you get a chance.'
      : 'It is waiting in your Client Requests tab for you to draft and deliver.',
    `Request #${id}.`,
  ].join('\n\n');
  // Fire-and-forget: sendNotificationEmail never rejects, so no .catch needed,
  // but the call itself is not awaited by callers either - never delay a
  // client-facing response on an email send.
  return sendNotificationEmail({ subject, text });
}

module.exports = { sendNotificationEmail, notifyNewDraftRequest };
