// ── Users ──────────────────────────────────────────────────────────────────
const usersRouter = require('express').Router();
const admin = require('firebase-admin');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const mailer = require('../services/mailer');

function ensureFirebaseAdmin() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil.');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const userReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Çok fazla bildirim denemesi yapıldı. Lütfen daha sonra tekrar deneyin.',
  },
});

// POST /api/users/:id/reports  (public)
usersRouter.post('/:id/reports', userReportLimiter, async (req, res, next) => {
  try {
    const { reason, description, reporter } = req.body;
    const reportedUser = req.body.reported_user || req.body.reportedUser;

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error: 'Bildirim sebebi zorunludur.',
      });
    }

    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
      subject: 'Nakliye Pazar Kullanıcı Bildirimi',
      text: `
Sebep: ${reason}
Açıklama: ${description || '-'}

Bildirilen Kullanıcı ID: ${req.params.id}
Ad Soyad: ${reportedUser?.name || '-'}
Telefon: ${reportedUser?.phone || '-'}
Şehir: ${reportedUser?.city || '-'}
İlçe: ${reportedUser?.district || '-'}

Bildiren: ${reporter?.name || 'Misafir'} (${reporter?.id || '-'})
Telefon: ${reporter?.phone || '-'}

Profil Fotoğrafı:
${reportedUser?.profile_image || '-'}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('User report mail error:', err);
    next(err);
  }
});

// GET /api/users/:id  (public profile)
usersRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id,name,phone_verified,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at
      FROM users WHERE id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/users/:id/reviews
usersRouter.get('/:id/reviews', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT r.*,
        json_build_object('id', reviewer.id, 'name', reviewer.name) AS reviewer,
        json_build_object('id', reviewee.id, 'name', reviewee.name) AS reviewee
      FROM reviews r
      JOIN users reviewer ON reviewer.id = r.reviewer_id
      JOIN users reviewee ON reviewee.id = r.reviewee_id
      WHERE r.reviewee_id=$1
      ORDER BY r.created_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});
// PATCH /api/users/me  (update own profile)
usersRouter.patch('/me', authMiddleware, async (req, res, next) => {
  try {
    const allowed = ['name', 'city', 'district', 'bio'];
    const sets = [], params = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    params.push(req.user.id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length}
       RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades,profile_image,created_at`,
      params
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/users/me/phone-verification-attempts — SMS başlamadan önce aylık limit kontrolü
usersRouter.post('/me/phone-verification-attempts', authMiddleware, async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Telefon numarası zorunludur.' });

    const { rows } = await query(`
      WITH recent AS (
        SELECT COUNT(*)::int AS attempt_count
        FROM phone_verification_attempts
        WHERE user_id=$1
          AND created_at >= NOW() - INTERVAL '30 days'
      ),
      inserted AS (
        INSERT INTO phone_verification_attempts (user_id, phone)
        SELECT $1, $2
        FROM recent
        WHERE attempt_count < 5
        RETURNING id
      )
      SELECT recent.attempt_count, inserted.id
      FROM recent
      LEFT JOIN inserted ON true
    `, [req.user.id, phone]);

    const result = rows[0];
    if (!result?.id) {
      return res.status(429).json({
        error: 'Telefon numarası doğrulama SMS limitiniz doldu. Bir hesap 30 gün içinde en fazla 5 kez telefon doğrulama SMS’i başlatabilir.',
      });
    }

    res.json({
      ok: true,
      remaining: Math.max(0, 4 - Number(result.attempt_count || 0)),
    });
  } catch (err) { next(err); }
});

// PATCH /api/users/me/phone — Firebase SMS ile doğrulanmış telefonu kaydet
usersRouter.patch('/me/phone', authMiddleware, async (req, res, next) => {
  try {
    ensureFirebaseAdmin();
    const idToken = String(req.body.idToken || '').trim();
    if (!idToken) return res.status(400).json({ error: 'Firebase token zorunludur.' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = String(decoded.phone_number || '').trim();
    if (!phone) return res.status(400).json({ error: 'Doğrulanmış telefon bulunamadı.' });

    const current = await query('SELECT firebase_uid FROM users WHERE id=$1', [req.user.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const currentFirebaseUid = current.rows[0].firebase_uid;
    if (currentFirebaseUid && currentFirebaseUid !== decoded.uid) {
      return res.status(403).json({ error: 'Firebase oturumu bu hesapla eşleşmiyor.' });
    }

    const { rows } = await query(`
      UPDATE users
      SET phone=$1, phone_verified=true, firebase_uid=COALESCE(firebase_uid, $2), updated_at=NOW()
      WHERE id=$3
      RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,
                is_verified,rating,total_trades,profile_image,created_at
    `, [phone, decoded.uid, req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Bu telefon numarası başka bir hesapta kayıtlı.' });
    }
    next(err);
  }
});

// DELETE /api/users/me  — permanently delete account and all related data
usersRouter.delete('/me', authMiddleware, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const userId = req.user.id;

    // 1. Delete messages in offers where this user is buyer or seller
    await client.query(`
      DELETE FROM messages
      WHERE offer_id IN (
        SELECT o.id FROM offers o
        JOIN listings l ON l.id = o.listing_id
        WHERE o.buyer_id = $1 OR l.seller_id = $1
      )
    `, [userId]);

    // 2. Delete offers where this user is buyer
    await client.query(`DELETE FROM offers WHERE buyer_id = $1`, [userId]);

    // 3. Delete offers on this user's listings (as seller)
    await client.query(`
      DELETE FROM offers
      WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = $1)
    `, [userId]);

    // 4. Delete this user's listings
    await client.query(`DELETE FROM listings WHERE seller_id = $1`, [userId]);

    // 5. Finally delete the user itself
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query('COMMIT');
    res.json({ message: 'Hesabınız ve tüm verileriniz başarıyla silindi.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = { usersRouter };
