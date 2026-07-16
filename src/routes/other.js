// ── Users ──────────────────────────────────────────────────────────────────
const usersRouter = require('express').Router();
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const mailer = require('../services/mailer');

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

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

// POST /api/users/:id/block  (auth required)
usersRouter.post('/:id/block', authMiddleware, async (req, res, next) => {
  try {
    const blockedId = req.params.id;
    if (blockedId === req.user.id) {
      return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz.' });
    }

    const { rows } = await query('SELECT id FROM users WHERE id=$1', [blockedId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    await query(`
      INSERT INTO user_blocks (blocker_id, blocked_id)
      VALUES ($1, $2)
      ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    `, [req.user.id, blockedId]);

    try {
      await mailer.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
        subject: 'Nakliye Pazar Kullanıcı Engelleme Bildirimi',
        text: `
Engelleyen kullanıcı ID: ${req.user.id}
Engellenen kullanıcı ID: ${blockedId}
Tarih: ${new Date().toISOString()}
Sebep: Diğer
Açıklama: Kullanıcı engelleme aksiyonu
        `,
      });
    } catch (mailErr) {
      console.error('User block notification mail error:', mailErr);
    }

    res.json({ ok: true, blocked_user_id: blockedId });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id/block  (auth required)
usersRouter.delete('/:id/block', authMiddleware, async (req, res, next) => {
  try {
    await query(
      'DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, blocked_user_id: req.params.id });
  } catch (err) { next(err); }
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
usersRouter.get('/:id', authMiddleware.optional, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id,name,phone_verified,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at,
             CASE
               WHEN $2::uuid IS NULL THEN false
               ELSE EXISTS (
                 SELECT 1 FROM user_blocks ub
                 WHERE ub.blocker_id = $2 AND ub.blocked_id = users.id
               )
             END AS is_blocked
      FROM users WHERE id=$1
    `, [req.params.id, req.user?.id || null]);
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
    const allowed = ['name', 'phone', 'city', 'district', 'bio'];
    const sets = [], params = [];
    let phoneProvided = false;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === 'phone') phoneProvided = true;
        params.push(key === 'phone' ? optionalText(req.body[key]) : req.body[key]);
        sets.push(`${key}=$${params.length}`);
      }
    }
    if (phoneProvided) sets.push('phone_verified=false');
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    params.push(req.user.id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length}
       RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades,profile_image,created_at`,
      params
    );
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
