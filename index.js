require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();

// Capture raw body for signature verification before JSON parsing
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

const API_BASE = process.env.MEDITICKET_API_URL || 'http://localhost:3000';
const WASENDER_API_URL = 'https://wasenderapi.com/api/send-message';

// ─── WaSender message sender ──────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  const res = await axios.post(
    WASENDER_API_URL,
    { to, text: message },
    {
      headers: {
        Authorization: `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log('[SEND] WaSender response:', JSON.stringify(res.data));
  if (!res.data?.success) {
    console.error('[SEND] WaSender error:', res.data);
  }
}

// ─── Webhook signature verification ──────────────────────────────────────────
function verifySignature(req) {
  const secret = process.env.WASENDER_WEBHOOK_SECRET;
  if (!secret) return true;

  // WaSender sends the raw secret as x-webhook-signature (not an HMAC)
  const signature = req.headers['x-webhook-signature'] ?? req.headers['x-webhook-secret'];
  return signature === secret;
}

// ─── MediTicket API helpers ───────────────────────────────────────────────────
async function fetchClinics() {
  const { data } = await axios.get(`${API_BASE}/api/public/clinics`);
  return data;
}

async function fetchTicketTypes(clinicId) {
  const { data } = await axios.get(`${API_BASE}/api/public/clinics/${clinicId}/ticket-types`);
  return data;
}

async function fetchPaymentMethods(clinicId) {
  const { data } = await axios.get(`${API_BASE}/api/public/clinics/${clinicId}/payment-methods`);
  return data;
}

async function createPurchase({ clinicId, ticketTypeId, paymentMethodId, buyerName, buyerPhone, paymentPhone }) {
  const { data } = await axios.post(
    `${API_BASE}/api/public/clinics/${clinicId}/purchases`,
    { buyerName, buyerPhone, paymentPhone, ticketTypeId, paymentMethodId }
  );
  return data;
}

// ─── Session store (keyed by phone number) ────────────────────────────────────
const sessions = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatList(items, labelFn) {
  return items.map((item, i) => `${i + 1}. ${labelFn(item)}`).join('\n');
}

function invalidChoice(max) {
  return `❌ Invalid choice. Reply with a number between 1 and ${max}.`;
}

function parseChoice(text, max) {
  const n = parseInt(text.trim(), 10);
  if (isNaN(n) || n < 1 || n > max) return null;
  return n;
}

const TRIGGERS = ['hi', 'hello', 'book', 'start', 'menu', 'hey'];

// ─── Conversation state machine (switch/case) ─────────────────────────────────
async function handleMessage(phone, text) {
  const normalised = text.trim().toLowerCase();
  let session = sessions[phone];

  if (TRIGGERS.includes(normalised) || !session) {
    try {
      const clinics = await fetchClinics();
      if (!clinics.length) {
        return '⚠️ No clinics are currently available. Please try again later.';
      }
      sessions[phone] = { step: 'SELECT_CLINIC', clinics };
      return (
        `👋 Welcome to *MediTicket*!\n\n` +
        `Please select a clinic:\n\n` +
        `${formatList(clinics, (c) => c.name)}\n\n` +
        `Reply with the number of your choice.`
      );
    } catch {
      return '⚠️ Unable to load clinics right now. Please try again shortly.';
    }
  }

  switch (session.step) {
    case 'SELECT_CLINIC': {
      const { clinics } = session;
      const choice = parseChoice(text, clinics.length);
      if (!choice) return invalidChoice(clinics.length);

      const clinic = clinics[choice - 1];

      let ticketTypes;
      try {
        ticketTypes = await fetchTicketTypes(clinic.id);
      } catch {
        return '⚠️ Could not load ticket types. Please try again.';
      }

      if (!ticketTypes.length) {
        return `⚠️ *${clinic.name}* has no ticket types available. Type *menu* to choose another clinic.`;
      }

      sessions[phone] = { ...session, step: 'SELECT_TICKET', clinic, ticketTypes };
      return (
        `🏥 *${clinic.name}*\n\n` +
        `Select a ticket type:\n\n` +
        `${formatList(ticketTypes, (t) => `${t.name} — GMD ${Number(t.price).toFixed(2)}`)}\n\n` +
        `Reply with the number of your choice.`
      );
    }

    case 'SELECT_TICKET': {
      const { ticketTypes, clinic } = session;
      const choice = parseChoice(text, ticketTypes.length);
      if (!choice) return invalidChoice(ticketTypes.length);

      const ticketType = ticketTypes[choice - 1];

      let paymentMethods;
      try {
        paymentMethods = await fetchPaymentMethods(clinic.id);
      } catch {
        return '⚠️ Could not load payment methods. Please try again.';
      }

      if (!paymentMethods.length) {
        return `⚠️ No payment methods are active for *${clinic.name}*. Type *menu* to start over.`;
      }

      sessions[phone] = { ...session, step: 'SELECT_PAYMENT', ticketType, paymentMethods };
      return (
        `🎫 *${ticketType.name}* — GMD ${Number(ticketType.price).toFixed(2)}\n\n` +
        `Select a payment method:\n\n` +
        `${formatList(paymentMethods, (m) => `${m.type} (${m.accountName})`)}\n\n` +
        `Reply with the number of your choice.`
      );
    }

    case 'SELECT_PAYMENT': {
      const { paymentMethods } = session;
      const choice = parseChoice(text, paymentMethods.length);
      if (!choice) return invalidChoice(paymentMethods.length);

      const paymentMethod = paymentMethods[choice - 1];

      sessions[phone] = { ...session, step: 'GET_NAME', paymentMethod };
      return `💳 *${paymentMethod.type}* selected.\n\nPlease enter your full name to complete the booking:`;
    }

    case 'GET_NAME': {
      const name = text.trim();
      if (name.length < 2) {
        return 'Please enter a valid full name.';
      }

      sessions[phone] = { ...session, step: 'GET_SMS_PHONE', buyerName: name };
      return (
        `👤 Name: *${name}*\n\n` +
        `Enter the phone number to receive your *ticket ID via SMS*\n` +
        `(include country code, digits only — e.g. 2207XXXXXX):`
      );
    }

    case 'GET_SMS_PHONE': {
      const smsPhone = text.trim().replace(/\s+/g, '');
      if (!/^\d{7,15}$/.test(smsPhone)) {
        return '❌ Invalid phone number. Enter digits only with country code (e.g. 2207XXXXXX):';
      }
      const paymentPhone = smsPhone;

      const { clinic, ticketType, paymentMethod, buyerName } = session;

      let purchase;
      try {
        purchase = await createPurchase({
          clinicId: clinic.id,
          ticketTypeId: ticketType.id,
          paymentMethodId: paymentMethod.id,
          buyerName,
          buyerPhone: phone,    // WhatsApp chat ID
          paymentPhone,         // mobile money number for Modem Pay
        });
      } catch (err) {
        const msg = err?.response?.data?.error || 'Could not process your booking.';
        return `⚠️ ${msg} Type *menu* to start over.`;
      }

      delete sessions[phone];

      return (
        `✅ *Booking confirmed!*\n\n` +
        `🏥 Clinic: *${clinic.name}*\n` +
        `🎫 Ticket: *${ticketType.name}*\n` +
        `💰 Amount: *GMD ${Number(ticketType.price).toFixed(2)}*\n` +
        `💳 Payment: *${paymentMethod.type}* (${paymentPhone})\n\n` +
        `Tap the link below to complete your payment:\n` +
        `${purchase.paymentLink}\n\n` +
        `Type *menu* to make another booking.`
      );
    }

    default: {
      delete sessions[phone];
      return 'Type *menu* to start a new booking.';
    }
  }
}

// ─── Message dedup (prevents double-processing from LID + real-JID twin events)
const processedIds = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false; // no ID — can't dedup, let it through
  if (processedIds.has(msgId)) return true;
  processedIds.add(msgId);
  if (processedIds.size > 500) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }
  return false;
}

// ─── Incoming webhook ─────────────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  try {
    if (!verifySignature(req)) {
      console.error('[WEBHOOK] Invalid signature — ignoring');
      return;
    }

    const { event, data } = req.body;

    if (event !== 'chats.update' && event !== 'messages.upsert' && event !== 'messages.received') return;

    const msgWrapper =
      data?.messages?.key
        ? data.messages
        : data?.chats?.messages?.[0]?.message;

    if (!msgWrapper) return;
    if (!msgWrapper.message || Object.keys(msgWrapper.message).length === 0) return; // empty twin event
    if (msgWrapper.key?.fromMe) return;

    const remoteJid    = msgWrapper.key?.remoteJid    ?? '';
    const remoteJidAlt = msgWrapper.key?.remoteJidAlt ?? '';

    // Skip LID-only events (no real phone alternative) — these are WaSender duplicates
    if (remoteJid.endsWith('@lid') && !remoteJidAlt) return;

    // Dedup by message ID — drops any remaining twin event
    const msgId = msgWrapper.key?.id;
    if (isDuplicate(msgId)) return;

    // Prefer remoteJidAlt (real phone) over remoteJid
    const jid   = remoteJidAlt || remoteJid;
    const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split('@')[0];

    const text =
      msgWrapper.message?.conversation ??
      msgWrapper.message?.extendedTextMessage?.text ??
      msgWrapper.message?.imageMessage?.caption ??
      msgWrapper.messageBody;

    console.log(`[WEBHOOK] jid=${jid} phone=${phone} text=${JSON.stringify(text)}`);
    console.log(`[WEBHOOK] msgWrapper keys:`, Object.keys(msgWrapper));

    if (!phone || !text) {
      console.log('[WEBHOOK] Skipping — missing phone or text');
      return;
    }

    const reply = await handleMessage(phone, text);
    console.log(`[WEBHOOK] Sending reply to ${jid}:`, reply.slice(0, 80));
    // WaSender needs full JID with @s.whatsapp.net
    const toJid = jid.includes('@') ? jid : `${phone}@s.whatsapp.net`;
    await sendWhatsApp(toJid, reply);
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`MediTicket WhatsApp bot running on port ${PORT}`));
