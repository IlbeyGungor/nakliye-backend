const router = require('express').Router();
const { body, query: qv, validationResult } = require('express-validator');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const mailer = require('../services/mailer');

// Reusable query to get full listing with seller info
const LISTING_SELECT = `
  SELECT
    l.*,
    l.title AS crop_name,
    l.transport_date AS harvest_date,
    json_build_object(
      'id', u.id, 'name', u.name, 'phone', u.phone,
      'phone_verified', u.phone_verified, 'city', u.city, 'district', u.district,
      'tc_verified', u.tc_verified, 'cks_verified', u.cks_verified,
      'is_verified', u.is_verified, 'rating', u.rating,
      'total_trades', u.total_trades, 'profile_image', u.profile_image
    ) AS seller
  FROM listings l
  JOIN users u ON u.id = l.seller_id
`;

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Çok fazla bildirim denemesi yapıldı. Lütfen daha sonra tekrar deneyin.',
  },
});

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

// GET /api/listings  (public, with optional filters)
router.get('/', async (req, res, next) => {
  try {
    const {
      search,
      listing_type,
      type,
      category,
      city,
      status,
      page = 1,
      limit = 20,
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ["l.status = 'active'"];

    if (status && status !== 'active') {
      return res.json({
        listings: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        l.title ILIKE $${params.length}
        OR l.category ILIKE $${params.length}
        OR l.body_type ILIKE $${params.length}
        OR l.city ILIKE $${params.length}
        OR l.district ILIKE $${params.length}
        OR l.address ILIKE $${params.length}
        OR l.origin_city ILIKE $${params.length}
        OR l.origin_district ILIKE $${params.length}
        OR l.origin_note ILIKE $${params.length}
        OR l.destination_city ILIKE $${params.length}
        OR l.destination_district ILIKE $${params.length}
        OR l.destination_note ILIKE $${params.length}
      )`);
    }
    const listingType = listing_type || type;
    if (listingType) { params.push(listingType); conditions.push(`l.listing_type = $${params.length}`); }
    if (category) { params.push(category); conditions.push(`l.category = $${params.length}`); }
    if (city) {
      params.push(city);
      conditions.push(`(
        l.city = $${params.length}
        OR l.origin_city = $${params.length}
        OR l.destination_city = $${params.length}
      )`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);

    const { rows } = await query(
      `${LISTING_SELECT} ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Total count for pagination
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`,
      countParams
    );

    res.json({
      listings: rows,
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countRows[0].count / limit),
    });
  } catch (err) { next(err); }
});

// GET /api/listings/:id  (public)
router.get('/:id', authMiddleware.optional, async (req, res, next) => {
  try {
    const { rows } = await query(`${LISTING_SELECT} WHERE l.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'İlan bulunamadı.' });

    const listing = rows[0];
    if (listing.status === 'reserved') {
      if (!req.user) return res.status(404).json({ error: 'İlan bulunamadı.' });

      const { rows: accessRows } = await query(
        `SELECT 1 FROM offers
         WHERE listing_id=$1 AND buyer_id=$2 AND status='accepted'
         LIMIT 1`,
        [req.params.id, req.user.id]
      );
      const canAccessReserved =
        listing.seller_id === req.user.id || accessRows.length > 0;
      if (!canAccessReserved) {
        return res.status(404).json({ error: 'İlan bulunamadı.' });
      }
    } else if (listing.status !== 'active') {
      const isOwner = req.user && listing.seller_id === req.user.id;
      if (!isOwner) return res.status(404).json({ error: 'İlan bulunamadı.' });
    }

    // Increment view count
    await query('UPDATE listings SET view_count = view_count + 1 WHERE id=$1', [req.params.id]);
    res.json(listing);
  } catch (err) { next(err); }
});

// POST /api/listings/:id/reports  (public)
router.post('/:id/reports', reportLimiter, async (req, res, next) => {
  try {
    const { reason, description, listing, reporter } = req.body;

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error: 'Bildirim sebebi zorunludur.',
      });
    }

    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
      subject: 'Nakliye Pazar Uygunsuz İçerik Bildirimi',
      text: `
Sebep: ${reason}
Açıklama: ${description || '-'}

İlan ID: ${req.params.id}
İlan Tipi: ${listing?.listing_type || '-'}
Başlık: ${listing?.crop_name || listing?.title || '-'}
Navlun: ${listing?.price || listing?.price_per_unit || '-'}
Yük/Kapasite: ${listing?.quantity || '-'}
Güzergah: ${listing?.route_display || listing?.location_display || [listing?.city, listing?.district].filter(Boolean).join(' / ') || '-'}
Nereden: ${[listing?.origin_city || listing?.city, listing?.origin_district || listing?.district].filter(Boolean).join(' / ') || '-'}
Yükleme Notu: ${listing?.origin_note || listing?.address || '-'}
Nereye: ${[listing?.destination_city, listing?.destination_district].filter(Boolean).join(' / ') || '-'}
Varış Notu: ${listing?.destination_note || '-'}
İlan Sahibi: ${listing?.seller_name || listing?.seller?.name || '-'} (${listing?.seller_id || listing?.seller?.id || '-'})

Bildiren: ${reporter?.name || 'Misafir'} (${reporter?.id || '-'})
Telefon: ${reporter?.phone || '-'}

Fotoğraflar:
${(listing?.image_urls || []).join('\n') || '-'}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Report mail error:', err);
    next(err);
  }
});

// POST /api/listings  (auth required)
router.post('/', authMiddleware, [
  body('listing_type').isIn(['vehicle_search','cargo_search']).withMessage('İlan tipi geçersiz.'),
  body('crop_name').optional({ nullable: true }).trim(),
  body('title').optional({ nullable: true }).trim(),
  body('category').isIn(['van','truck','semi_truck','other']),
  body('body_type').optional({ nullable: true }).trim(),
  body('quantity').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('price_per_unit').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('origin_city').optional({ nullable: true }).trim(),
  body('origin_district').optional({ nullable: true }).trim(),
  body('origin_note').optional({ nullable: true }).trim(),
  body('destination_city').optional({ nullable: true }).trim(),
  body('destination_district').optional({ nullable: true }).trim(),
  body('destination_note').optional({ nullable: true }).trim(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      listing_type, category, quantity, unit = 'ton',
      price_per_unit, price_type = 'negotiate',
      city, district, address, description
    } = req.body;
    const title = String(req.body.title || req.body.crop_name || '').trim();
    const transportDate = req.body.transport_date || req.body.harvest_date || null;
    const originCity = emptyToNull(req.body.origin_city ?? req.body.originCity ?? city);
    const originDistrict = emptyToNull(req.body.origin_district ?? req.body.originDistrict ?? district);
    const originNote = emptyToNull(req.body.origin_note ?? req.body.originNote ?? address);
    const destinationCity = emptyToNull(req.body.destination_city ?? req.body.destinationCity);
    const destinationDistrict = emptyToNull(req.body.destination_district ?? req.body.destinationDistrict);
    const destinationNote = emptyToNull(req.body.destination_note ?? req.body.destinationNote);
    const bodyType = emptyToNull(req.body.body_type ?? req.body.bodyType);
    const legacyCity = emptyToNull(city) || originCity;
    const legacyDistrict = emptyToNull(district) || originDistrict;
    const legacyAddress = emptyToNull(address) || originNote;
    if (!title) {
      return res.status(400).json({ error: 'İlan başlığı zorunludur.' });
    }

    const { rows } = await query(`
      INSERT INTO listings
        (seller_id,listing_type,title,category,body_type,quantity,unit,price_per_unit,price_type,city,district,address,origin_city,origin_district,origin_note,destination_city,destination_district,destination_note,description,transport_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *, title AS crop_name, transport_date AS harvest_date
    `, [req.user.id, listing_type, title, category, bodyType, quantity, unit, price_per_unit, price_type,
        legacyCity, legacyDistrict, legacyAddress,
        originCity, originDistrict, originNote,
        destinationCity, destinationDistrict, destinationNote,
        emptyToNull(description), transportDate]);

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/listings/:id  (auth, owner only)
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: existing } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (existing[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    const keyMap = {
      crop_name: 'title',
      title: 'title',
      listing_type: 'listing_type',
      category: 'category',
      body_type: 'body_type',
      bodyType: 'body_type',
      quantity: 'quantity',
      price_per_unit: 'price_per_unit',
      price_type: 'price_type',
      city: 'city',
      district: 'district',
      address: 'address',
      origin_city: 'origin_city',
      originCity: 'origin_city',
      origin_district: 'origin_district',
      originDistrict: 'origin_district',
      origin_note: 'origin_note',
      originNote: 'origin_note',
      destination_city: 'destination_city',
      destinationCity: 'destination_city',
      destination_district: 'destination_district',
      destinationDistrict: 'destination_district',
      destination_note: 'destination_note',
      destinationNote: 'destination_note',
      description: 'description',
      status: 'status',
      harvest_date: 'transport_date',
      transport_date: 'transport_date',
    };
    const sets = [], params = [];
    for (const key of Object.keys(keyMap)) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${keyMap[key]}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE listings SET ${sets.join(',')}, updated_at=NOW()
       WHERE id=$${params.length}
       RETURNING *, title AS crop_name, transport_date AS harvest_date`,
      params
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/listings/:id  (auth, owner only)
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT seller_id FROM listings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (rows[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    await query('DELETE FROM listings WHERE id=$1', [req.params.id]);
    res.json({ message: 'İlan silindi.' });
  } catch (err) { next(err); }
});

module.exports = router;
