// MAILER  (sends the email-verification link)
// ------------------------------------------------------------------
// Pluggable: if RESEND_API_KEY is set, it sends a real email via Resend's HTTP
// API (no dependency — plain fetch). Otherwise it runs in DEV mode and prints
// the verification link to the server console so you can test without signing
// up for an email provider.
//
// To go live: set RESEND_API_KEY and MAIL_FROM in .env (a verified sender).
// Swapping Resend for SendGrid/SES/etc. means changing only this file.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MyFX <onboarding@resend.dev>';

export function mailerMode() {
  return RESEND_API_KEY ? 'resend' : 'dev-console';
}

export async function sendVerificationEmail(email, link) {
  if (!RESEND_API_KEY) {
    // DEV fallback — no email actually sent; use this link to verify.
    console.log('\n──────────── EMAIL VERIFICATION (dev mode) ────────────');
    console.log(`To:   ${email}`);
    console.log(`Link: ${link}`);
    console.log('Set RESEND_API_KEY in .env to send real emails.');
    console.log('───────────────────────────────────────────────────────\n');
    return { delivered: false, mode: 'dev-console' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: email,
      subject: 'Verify your MyFX email',
      html: `<p>Welcome to MyFX. Please verify your email:</p>
             <p><a href="${link}">Verify my email</a></p>
             <p>This link expires in 24 hours.</p>`,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed: HTTP ${res.status} ${detail}`);
  }
  return { delivered: true, mode: 'resend' };
}
