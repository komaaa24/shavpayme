require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

/**
 * Payme (Paycom) one‑time payment server (production‑ready skeleton).
 * - PostgreSQL persistence for donations and transactions.
 * - Checkout form at POST /donate
 * - Merchant API (JSON-RPC 2.0) at POST /payme/merchant and /api/payme
 */

/* ------------------------- Configuration ------------------------- */
const MERCHANT_ID = process.env.PAYME_MERCHANT_ID;
const SECRET_KEY = process.env.PAYME_SECRET_KEY; // Basic auth: Paycom:<SECRET_KEY>
const ACCOUNT_FIELD = process.env.PAYME_ACCOUNT_FIELD || 'donation_id';
const BASE_URL = process.env.BASE_URL || 'https://example.com';
const PORT = Number(process.env.PORT || 3000);
const CHECKOUT_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://checkout.paycom.uz'
    : 'https://test.paycom.uz';
const TRANSACTION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours per Payme spec
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

if (!MERCHANT_ID || !SECRET_KEY) {
  console.error('PAYME_MERCHANT_ID and PAYME_SECRET_KEY are required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (postgres connection string)');
  process.exit(1);
}

/* --------------------------- App setup --------------------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ----------------------- Utility helpers ------------------------- */
const now = () => Date.now();
const toTiyin = (sumUz) => Math.round(Number(sumUz) * 100);
const msg = (text) => ({ uz: text, ru: text, en: text });

const ERR = {
  AUTH: { code: -32504, message: msg('Huquq yetarli emas') },
  AMOUNT: { code: -31001, message: msg('Noto‘g‘ri summa'), data: 'amount' },
  NOT_FOUND: { code: -31003, message: msg('Tranzaksiya topilmadi'), data: 'id' },
  CANNOT_PERFORM: { code: -31008, message: msg('Amalni bajarish mumkin emas') },
  ACCOUNT: { code: -31050, message: msg('Noto‘g‘ri hisob'), data: 'account' },
  METHOD: { code: -32601, message: msg('Metod topilmadi') },
};

const ok = (res, id, result) => res.json({ id, result });
const fail = (res, id, error) => res.json({ id, error });

function requirePaymeAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decoded === `Paycom:${SECRET_KEY}`;
}

/* --------------------------- DB schema --------------------------- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      id UUID PRIMARY KEY,
      amount INTEGER NOT NULL,            -- in tiyins
      state SMALLINT NOT NULL DEFAULT 0,  -- 0=new,1=created,2=paid,-1/-2 cancelled
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      paycom_id TEXT PRIMARY KEY,
      donation_id UUID NOT NULL REFERENCES donations(id),
      amount INTEGER NOT NULL,
      state SMALLINT NOT NULL,
      create_time BIGINT NOT NULL,
      perform_time BIGINT DEFAULT 0,
      cancel_time BIGINT DEFAULT 0,
      reason INTEGER
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_donation ON transactions(donation_id);`);
}

/* --------------------------- DB helpers -------------------------- */
async function createDonation(donationId, amount) {
  await pool.query(
    `INSERT INTO donations (id, amount, state) VALUES ($1,$2,0)
     ON CONFLICT (id) DO NOTHING`,
    [donationId, amount]
  );
  return getDonation(donationId);
}

async function getDonation(donationId) {
  const { rows } = await pool.query(
    `SELECT id, amount, state, created_at FROM donations WHERE id = $1`,
    [donationId]
  );
  return rows[0];
}

async function saveTransaction(tx) {
  await pool.query(
    `INSERT INTO transactions(paycom_id, donation_id, amount, state, create_time, perform_time, cancel_time, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (paycom_id) DO UPDATE SET
       state = EXCLUDED.state,
       perform_time = EXCLUDED.perform_time,
       cancel_time = EXCLUDED.cancel_time,
       reason = EXCLUDED.reason`,
    [
      tx.paycomTxId,
      tx.account,
      tx.amount,
      tx.state,
      tx.create_time,
      tx.perform_time,
      tx.cancel_time,
      tx.reason,
    ]
  );
}

async function getTransaction(paycomTxId) {
  const { rows } = await pool.query(
    `SELECT paycom_id, donation_id, amount, state, create_time, perform_time, cancel_time, reason
     FROM transactions WHERE paycom_id = $1`,
    [paycomTxId]
  );
  return rows[0]
    ? {
        paycomTxId: rows[0].paycom_id,
        account: rows[0].donation_id,
        amount: rows[0].amount,
        state: rows[0].state,
        create_time: rows[0].create_time,
        perform_time: rows[0].perform_time,
        cancel_time: rows[0].cancel_time,
        reason: rows[0].reason,
      }
    : null;
}

async function setDonationState(donationId, state) {
  await pool.query(`UPDATE donations SET state = $2 WHERE id = $1`, [donationId, state]);
}

async function listTransactions(from, to) {
  const { rows } = await pool.query(
    `SELECT paycom_id, donation_id, amount, state, create_time, perform_time, cancel_time, reason
     FROM transactions
     WHERE create_time >= $1 AND create_time <= $2
     ORDER BY create_time ASC`,
    [from || 0, to || now()]
  );
  return rows.map((r) => ({
    paycomTxId: r.paycom_id,
    account: r.donation_id,
    amount: r.amount,
    state: r.state,
    create_time: r.create_time,
    perform_time: r.perform_time,
    cancel_time: r.cancel_time,
    reason: r.reason,
  }));
}

/* ------------------------- JSON-RPC helpers ---------------------- */
function txResponse(tx) {
  return {
    transaction: tx.paycomTxId,
    account: { [ACCOUNT_FIELD]: tx.account },
    create_time: tx.create_time,
    perform_time: tx.perform_time,
    cancel_time: tx.cancel_time,
    amount: tx.amount,
    state: tx.state,
    reason: tx.reason,
  };
}

function isExpired(tx) {
  return tx.create_time + TRANSACTION_TTL_MS < now();
}

async function autoCancelExpired(tx) {
  if (!tx || tx.state !== 1) return tx;
  tx.state = -1;
  tx.cancel_time = now();
  tx.reason = 4;
  await saveTransaction(tx);
  return tx;
}

/* ----------------------- Public endpoints ------------------------ */
app.get('/health', (_req, res) => res.json({ ok: true }));

// Demo helper to create donation record
app.post('/mock-donation-init', async (req, res) => {
  try {
    const amountUz = Number(req.body.amount || 10000);
    if (!amountUz || amountUz <= 0) return res.status(400).json({ error: 'amount required' });
    const donationId = crypto.randomUUID();
    const amount = toTiyin(amountUz);
    const donation = await createDonation(donationId, amount);
    return res.json({ donationId: donation.id, account: { [ACCOUNT_FIELD]: donation.id }, amount, amountUz });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Render auto-submit Payme checkout form
app.post('/donate', async (req, res) => {
  try {
    const amountUz = Number(req.body.amount);
    if (!amountUz || amountUz <= 0) return res.status(400).send('amount required');
    const donationId = req.body.donationId || crypto.randomUUID();
    const amount = toTiyin(amountUz);
    await createDonation(donationId, amount);

    const callback = `${BASE_URL}/payme/callback/:transaction?donation=${donationId}`;

    res.send(`<!doctype html><body onload="document.forms[0].submit()">
<form method="POST" action="${CHECKOUT_URL}">
  <input type="hidden" name="merchant" value="${MERCHANT_ID}">
  <input type="hidden" name="amount" value="${amount}">
  <input type="hidden" name="account[${ACCOUNT_FIELD}]" value="${donationId}">
  <input type="hidden" name="lang" value="uz">
  <input type="hidden" name="callback" value="${callback}">
  <input type="hidden" name="description[uz]" value="Xayriya to'lovi #${donationId}">
  <noscript><button type="submit">Payme orqali to'lash</button></noscript>
</form></body>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('internal error');
  }
});

/* ----------------------- Merchant API ---------------------------- */
const merchantHandler = async (req, res) => {
  if (!requirePaymeAuth(req)) return fail(res, req.body?.id, ERR.AUTH);

  const { id, method, params } = req.body;
  const donationId = params?.account?.[ACCOUNT_FIELD];
  const amount = params?.amount;
  const paycomTxId = params?.id;

  try {
    switch (method) {
      case 'CheckPerformTransaction':
        return await handleCheckPerform(res, id, donationId, amount);
      case 'CreateTransaction':
        return await handleCreate(res, id, donationId, amount, paycomTxId);
      case 'PerformTransaction':
        return await handlePerform(res, id, paycomTxId);
      case 'CancelTransaction':
        return await handleCancel(res, id, paycomTxId, params?.reason ?? 0);
      case 'CheckTransaction':
        return await handleCheck(res, id, paycomTxId);
      case 'GetStatement':
        return await handleStatement(res, id, params?.from, params?.to);
      default:
        return fail(res, id, ERR.METHOD);
    }
  } catch (err) {
    console.error('merchant handler error', err);
    return fail(res, id, { code: -32400, message: msg('Server xatosi') });
  }
};

app.post(['/payme/merchant', '/api/payme'], merchantHandler);

/* ------------------- Merchant method handlers -------------------- */
async function handleCheckPerform(res, id, donationId, amount) {
  const donation = await getDonation(donationId);
  if (!donation) return fail(res, id, ERR.ACCOUNT);
  if (donation.amount !== amount) return fail(res, id, ERR.AMOUNT);
  return ok(res, id, { allow: true });
}

async function handleCreate(res, id, donationId, amount, paycomTxId) {
  const donation = await getDonation(donationId);
  if (!donation) return fail(res, id, ERR.ACCOUNT);
  if (donation.amount !== amount) return fail(res, id, ERR.AMOUNT);
  if (donation.state === 2) return fail(res, id, ERR.CANNOT_PERFORM);

  let tx = await getTransaction(paycomTxId);
  if (tx) {
    if (tx.account === donationId && tx.amount === amount) {
      if (isExpired(tx) && tx.state === 1) {
        tx = await autoCancelExpired(tx);
      }
      return ok(res, id, txResponse(tx));
    }
    return fail(res, id, ERR.CANNOT_PERFORM);
  }

  tx = {
    paycomTxId,
    account: donationId,
    amount,
    state: 1,
    create_time: now(),
    perform_time: 0,
    cancel_time: 0,
    reason: null,
  };
  await saveTransaction(tx);
  // Optionally mark donation as "created"
  await setDonationState(donationId, 1);
  return ok(res, id, txResponse(tx));
}

async function handlePerform(res, id, paycomTxId) {
  let tx = await getTransaction(paycomTxId);
  if (!tx) return fail(res, id, ERR.NOT_FOUND);
  if (isExpired(tx) && tx.state === 1) tx = await autoCancelExpired(tx);
  if (tx.state === -1 || tx.state === -2) return fail(res, id, ERR.CANNOT_PERFORM);
  if (tx.state === 2) return ok(res, id, txResponse(tx)); // idempotent

  tx.state = 2;
  tx.perform_time = now();
  await saveTransaction(tx);
  await setDonationState(tx.account, 2);
  return ok(res, id, txResponse(tx));
}

async function handleCancel(res, id, paycomTxId, reason) {
  let tx = await getTransaction(paycomTxId);
  if (!tx) return fail(res, id, ERR.NOT_FOUND);
  if (isExpired(tx) && tx.state === 1) tx = await autoCancelExpired(tx);
  if (tx.state === -1 || tx.state === -2) return ok(res, id, txResponse(tx));

  tx.state = tx.state === 2 ? -2 : -1;
  tx.cancel_time = now();
  tx.reason = reason;
  await saveTransaction(tx);
  await setDonationState(tx.account, tx.state);
  return ok(res, id, txResponse(tx));
}

async function handleCheck(res, id, paycomTxId) {
  let tx = await getTransaction(paycomTxId);
  if (!tx) return fail(res, id, ERR.NOT_FOUND);
  if (isExpired(tx) && tx.state === 1) tx = await autoCancelExpired(tx);
  return ok(res, id, txResponse(tx));
}

async function handleStatement(res, id, from, to) {
  const items = await listTransactions(from, to);
  return ok(res, id, { transactions: items.map(txResponse) });
}

/* --------------------------- Start app --------------------------- */
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Payme donation server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB init failed', err);
    process.exit(1);
  });

