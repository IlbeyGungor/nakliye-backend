require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./index');

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE messages, offers, listings, users RESTART IDENTITY CASCADE');

    const hash = await bcrypt.hash('demo1234', 10);

    const u1 = uuidv4(), u2 = uuidv4(), u3 = uuidv4();

    await client.query(`
      INSERT INTO users (id,name,phone,phone_verified,password_hash,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades)
      VALUES
        ($1,'Murat Lojistik','+905321234567',true,$4,'İstanbul','Esenler','Şehirler arası parsiyel ve komple taşımacılık yapıyoruz.',true,true,true,4.8,82),
        ($2,'Ece Nakliyat','+905422223344',true,$4,'İzmir','Bornova','Frigorifik ve kapalı kasa araçlarımızla düzenli seferlerimiz var.',true,false,true,4.6,41),
        ($3,'Anadolu Yük','+905334445566',true,$4,'Konya','Selçuklu','İç Anadolu çıkışlı fabrika ve depo yükleri için ilan açıyoruz.',true,false,true,4.7,95)
    `, [u1, u2, u3, hash]);

    const l1 = uuidv4(), l2 = uuidv4(), l3 = uuidv4(), l4 = uuidv4();

    await client.query(`
      INSERT INTO listings (
        id,seller_id,listing_type,title,category,quantity,unit,price_per_unit,
        price_type,city,district,address,origin_city,origin_district,origin_note,
        destination_city,destination_district,destination_note,description,status,transport_date
      )
      VALUES
        ($1,$5,'vehicle_search','İstanbul - Ankara 18 ton paletli yük','semi_truck',18,'ton',4200,'negotiate','İstanbul','Esenler','Esenler depo çıkışı','İstanbul','Esenler','Yarın sabah yükleme yapılacak.','Ankara','Yenimahalle','Sanayi bölgesi teslim.','Tenteli tır veya kapalı kasa uygundur.','active',CURRENT_DATE + 1),
        ($2,$6,'cargo_search','İzmir çıkışlı frigorifik araç müsait','refrigerated',22,'ton',5200,'fixed','İzmir','Bornova','Bornova çıkışlı','İzmir','Bornova','Hafta içi yükleme uygundur.','İstanbul','Tuzla','Soğuk zincir varış için uygundur.','Ege ve Marmara rotalarına uygun frigorifik araç.','active',CURRENT_DATE + 2),
        ($3,$7,'vehicle_search','Konya - Mersin konteyner taşıması','container',1,'sefer',7800,'negotiate','Konya','Selçuklu','Selçuklu fabrika çıkışı','Konya','Selçuklu','40 feet konteyner için yükleme.','Mersin','Akdeniz','Liman teslimli.','Konteyner taşıması için araç arıyoruz.','active',CURRENT_DATE + 3),
        ($4,$6,'cargo_search','Boş dönüş: Bursa - İstanbul kamyonet','van',3,'ton',1800,'negotiate','Bursa','Nilüfer','Nilüfer çıkışlı','Bursa','Nilüfer','Bugün akşam çıkış var.','İstanbul','Esenyurt','Parsiyel yük alınır.','Boş dönüş için kamyonet müsait.','active',CURRENT_DATE)
    `, [l1, l2, l3, l4, u1, u2, u3]);

    await client.query('COMMIT');
    console.log('✅  Seed complete');
    console.log('   Demo login → phone: +905321234567  password: demo1234');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
