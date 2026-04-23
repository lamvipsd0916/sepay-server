const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FEE_AMOUNT = Number(process.env.FEE_AMOUNT || 10000);
const SEPAY_SHARED_SECRET = process.env.SEPAY_SHARED_SECRET || '';

let firebaseReady = false;

function initFirebase() {
  if (firebaseReady) return;

  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }
  }

  firebaseReady = true;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function extractOrderId(content) {
  const text = normalizeText(content).toUpperCase();
  const match = text.match(/TROHUB[-_ ]?([A-Z0-9]+)/);
  return match ? match[1] : '';
}

async function updateBookingPaid(orderId, payment) {
  initFirebase();
  const db = admin.firestore();

  const bookingRef = db.collection('dat_lich').doc(orderId);
  const snap = await bookingRef.get();

  if (!snap.exists) {
    return { ok: false, reason: 'booking_not_found' };
  }

  const booking = snap.data() || {};
  await bookingRef.update({
    daThanhToan: true,
    trangThai: 'cho_xac_nhan',
    ngayThanhToan: admin.firestore.FieldValue.serverTimestamp(),
    paymentProvider: 'sepay',
    paymentAmount: payment.amount,
    paymentContent: payment.content,
    paymentRaw: payment.raw,
    paymentTxnId: payment.txnId,
    paymentBank: payment.bank,
  });

  await db.collection('thong_bao').add({
    userId: booking.nguoiDatId || '',
    tieuDe: 'Thanh toán thành công',
    noiDung: `Bạn đã thanh toán thành công ${FEE_AMOUNT.toLocaleString('vi-VN')}đ cho lịch hẹn ${booking.tenPhong || ''}.`,
    loai: 'thanh_toan_dat_lich',
    phongId: booking.phongId || '',
    lichId: orderId,
    daDoc: false,
    ngayTao: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (booking.chuPhongId) {
    await db.collection('thong_bao').add({
      userId: booking.chuPhongId,
      tieuDe: 'Đã nhận thanh toán đặt lịch',
      noiDung: `Đơn đặt lịch ${booking.tenPhong || ''} đã được thanh toán ${FEE_AMOUNT.toLocaleString('vi-VN')}đ.`,
      loai: 'thanh_toan_dat_lich',
      phongId: booking.phongId || '',
      lichId: orderId,
      daDoc: false,
      ngayTao: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { ok: true };
}

app.get('/', (req, res) => {
  res.send('Server OK');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sepay-server' });
});

app.post('/create-payment', async (req, res) => {
  try {
    const { orderId, amount, content } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, message: 'orderId is required' });
    }

    const payAmount = Number(amount || FEE_AMOUNT);
    const transferContent = normalizeText(content) || `TROHUB ${orderId}`;

    return res.json({
      ok: true,
      orderId,
      amount: payAmount,
      content: transferContent,
      qrText: `BANK:BIDV|ACCOUNT:962470765608117|NAME:TRAN THANH PHONG|AMOUNT:${payAmount}|CONTENT:${transferContent}`,
      bank: 'BIDV',
      accountNumber: '962470765608117',
      accountName: 'TRAN THANH PHONG',
    });
  } catch (e) {
    console.error('create-payment error:', e);
    return res.status(500).json({ ok: false, message: 'Internal error' });
  }
});

app.post('/sepay-webhook', async (req, res) => {
  try {
    const data = req.body || {};
    console.log('Webhook nhận:', data);

    if (SEPAY_SHARED_SECRET) {
      const secret = normalizeText(req.headers['x-sepay-secret'] || req.headers['x-webhook-secret']);
      if (secret !== SEPAY_SHARED_SECRET) {
        return res.status(401).json({ ok: false, message: 'Invalid secret' });
      }
    }

    const amount = Number(data.amount || data.totalAmount || data.transferAmount || 0);
    const content = normalizeText(data.content || data.description || data.transferContent || '');
    const orderId = normalizeText(data.orderId || data.reference || extractOrderId(content));

    if (!orderId) {
      return res.status(400).json({ ok: false, message: 'orderId not found in webhook content' });
    }

    if (amount !== FEE_AMOUNT) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'amount_mismatch' });
    }

    const result = await updateBookingPaid(orderId, {
      amount,
      content,
      txnId: normalizeText(data.transactionId || data.id || data.refNo || ''),
      bank: normalizeText(data.bank || data.bankName || 'BIDV'),
      raw: data,
    });

    if (!result.ok) {
      return res.status(404).json({ ok: false, message: result.reason });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ ok: false, message: 'Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server chạy port ${PORT}`);
});
