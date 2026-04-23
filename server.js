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
  if (admin.apps.length) { firebaseReady = true; return; }

  // Fail fast với lỗi rõ ràng thay vì dùng applicationDefault() sẽ crash trên Render
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env variable is not set');
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  firebaseReady = true;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function extractOrderId(content) {
  const text = normalizeText(content).toUpperCase();
  // Hỗ trợ: "TROHUB 1234", "TROHUB-1234", "TROHUB_1234", "TROHUB1234"
  const match = text.match(/TROHUB[\s\-_]?([0-9A-Z]+)/);
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

  if (booking.daThanhToan === true) {
    return { ok: true, alreadyPaid: true }; // idempotent — không xử lý lại
  }

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
    noiDung: `Bạn đã thanh toán thành công ${payment.amount.toLocaleString('vi-VN')}đ cho lịch hẹn ${booking.tenPhong || ''}.`,
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
      noiDung: `Đơn đặt lịch ${booking.tenPhong || ''} đã được thanh toán ${payment.amount.toLocaleString('vi-VN')}đ.`,
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
  res.json({ ok: true, service: 'sepay-server', feeAmount: FEE_AMOUNT });
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
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/sepay-webhook', async (req, res) => {
  try {
    const data = req.body || {};
    console.log('Webhook nhận:', JSON.stringify(data));

    if (SEPAY_SHARED_SECRET) {
      const secret = normalizeText(req.headers['x-sepay-secret'] || req.headers['x-webhook-secret']);
      if (secret !== SEPAY_SHARED_SECRET) {
        return res.status(401).json({ ok: false, message: 'Invalid secret' });
      }
    }

    // Chỉ xử lý giao dịch tiền vào
    if (data.transferType && data.transferType !== 'in') {
      return res.status(200).json({ ok: true, ignored: true, reason: 'not_incoming' });
    }

    const amount = Number(data.transferAmount || data.amount || data.totalAmount || 0);
    const content = normalizeText(data.content || data.description || data.transferContent || '');
    const orderId = normalizeText(data.orderId || data.reference || extractOrderId(content));

    console.log(`Webhook parse → amount=${amount}, orderId="${orderId}", content="${content}"`);

    if (!orderId) {
      console.warn('Webhook bị bỏ qua: không tìm thấy orderId trong nội dung');
      return res.status(200).json({ ok: true, ignored: true, reason: 'orderId_not_found' });
    }

    // Cho phép >= FEE_AMOUNT (tránh reject nếu người dùng chuyển dư)
    if (amount < FEE_AMOUNT) {
      console.warn(`Webhook bị bỏ qua: amount=${amount} < FEE_AMOUNT=${FEE_AMOUNT}`);
      return res.status(200).json({ ok: true, ignored: true, reason: 'amount_insufficient', received: amount, required: FEE_AMOUNT });
    }

    const result = await updateBookingPaid(orderId, {
      amount,
      content,
      txnId: normalizeText(String(data.id || data.transactionId || data.refNo || '')),
      bank: normalizeText(data.gateway || data.bank || data.bankName || 'BIDV'),
      raw: data,
    });

    if (!result.ok) {
      console.warn(`updateBookingPaid thất bại: ${result.reason}`);
      return res.status(404).json({ ok: false, message: result.reason });
    }

    return res.json({ ok: true, alreadyPaid: result.alreadyPaid || false });
  } catch (e) {
    console.error('Webhook error:', e.message, e.stack);
    return res.status(500).json({ ok: false, message: e.message }); // trả lỗi thật để debug
  }
});

app.listen(PORT, () => {
  console.log(`Server chạy port ${PORT} | FEE_AMOUNT=${FEE_AMOUNT}`);
});
