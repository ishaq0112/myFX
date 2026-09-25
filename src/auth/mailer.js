// MAILER  (transactional emails: verification, password reset, …)
// ------------------------------------------------------------------
// Pluggable and dependency-free (plain fetch). If RESEND_API_KEY is set, emails
// are sent via Resend's HTTP API; otherwise it runs in DEV mode and prints the
// actionable link to the server console so you can test without an email
// provider. Swapping Resend for SendGrid/SES/etc. means changing only sendEmail.
//
// To go live: set RESEND_API_KEY and MAIL_FROM (a verified sender) in .env.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MyFX <onboarding@resend.dev>';

export function mailerMode() {
  return RESEND_API_KEY ? 'resend' : 'dev-console';
}

/** Core send. In dev mode (no key) it logs instead of sending. `devLink` is the
 *  actionable URL to surface in the console for local testing. */
export async function sendEmail({ to, subject, html, devLink }) {
  if (!RESEND_API_KEY) {
    console.log('\n──────────── EMAIL (dev mode — not sent) ────────────');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    if (devLink) console.log(`Link:    ${devLink}`);
    console.log('Set RESEND_API_KEY in .env to send real emails.');
    console.log('─────────────────────────────────────────────────────\n');
    return { delivered: false, mode: 'dev-console' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed: HTTP ${res.status} ${detail}`);
  }
  return { delivered: true, mode: 'resend' };
}

// Branded, email-client-safe HTML (inline styles + tables — no external CSS).
function emailShell(heading, paragraphs, cta) {
  const body = paragraphs
    .map((t) => `<p style="margin:0 0 16px;color:#44403c;font-size:15px;line-height:1.6">${t}</p>`)
    .join('');
  const button = cta
    ? `<p style="margin:26px 0 10px"><a href="${cta.href}" style="display:inline-block;background:#ef6820;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:9px">${cta.text}</a></p>
       <p style="margin:0;color:#9c968e;font-size:12px;line-height:1.5;word-break:break-all">Or paste this link into your browser:<br><a href="${cta.href}" style="color:#c2410c">${cta.href}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f2ee;padding:28px 16px;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #ece7e1;border-radius:14px;overflow:hidden">
      <tr><td style="padding:22px 28px;border-bottom:1px solid #f0ece6">
        <span style="font-size:19px;font-weight:800;color:#1c1917">My<span style="color:#ef6820">FX</span></span>
      </td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 16px;font-size:21px;color:#1c1917;letter-spacing:-0.3px">${heading}</h1>
        ${body}${button}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #f0ece6;color:#9c968e;font-size:12px;line-height:1.5">
        MyFX — live exchange-rate API. If you weren't expecting this email, you can safely ignore it.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function sendVerificationEmail(email, link) {
  return sendEmail({
    to: email,
    subject: 'Verify your MyFX email',
    html: emailShell(
      'Verify your email',
      ['Welcome to MyFX. Confirm your email address to activate your account.', 'This link expires in 24 hours.'],
      { text: 'Verify my email', href: link },
    ),
    devLink: link,
  });
}

export function sendPasswordResetEmail(email, link) {
  return sendEmail({
    to: email,
    subject: 'Reset your MyFX password',
    html: emailShell(
      'Reset your password',
      ['We received a request to reset your MyFX password. Click below to choose a new one.', 'This link expires in 1 hour. If you didn’t request it, ignore this email and your password stays the same.'],
      { text: 'Reset password', href: link },
    ),
    devLink: link,
  });
}
